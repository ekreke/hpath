// Real-mode RunCase wiring (T8): the bridge between the shared AgentKernel
// pipeline and the RunCase gRPC stream.
//
// One handler = one run:
//   1. validate project/env/case ownership + APPROVED status (mock parity),
//   2. persist the run as RUNNING, then execute the case through the kernel
//      (`execute-agent`) while streaming events: every kernel event is mapped
//      to its proto Event branch, appended to the `events` table, and written
//      to the client in order. Screenshot bytes are uploaded to the artifact
//      store first and stream as `screenshot { artifact_id, caption }`.
//   3. after the run settles, binary by-products (Playwright video/trace)
//      upload to the artifact store and the run finishes with its verdict,
//      token cost, duration and fail reason (limit breaches keep evidence).
//
// Client disconnects do not abort the run: the kernel keeps executing and
// persisting evidence (the definition's wall-clock limit bounds it); the
// stream simply stops writing.

import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { status } from "@grpc/grpc-js";
import type {
  sendUnaryData,
  ServerUnaryCall,
  ServerWritableStream,
  ServiceError,
} from "@grpc/grpc-js";
import {
  ArtifactKind,
  CaseStatus,
  RunStatus,
  RunTrigger,
  VerdictStatus,
  type Artifact,
  type BytesChunk,
  type Case,
  type DownloadArtifactRequest,
  type Env,
  type Event,
  type GetRunRequest,
  type Run,
  type RunCaseRequest,
  type RunDetail,
  type Verdict,
} from "@hpath/contract";
import { CompositeEventSink, InMemoryEventSink } from "../agents/events.js";
import type { AgentEventSink } from "../agents/events.js";
import { EXECUTE_AGENT_ID } from "../agents/execute-agent.js";
import type { AgentKernel } from "../agents/pipeline.js";
import type {
  AgentRunEvent,
  AgentRunEventPayload,
  AgentRunResult,
  EnvBinding,
  Verdict as KernelVerdict,
} from "../agents/types.js";
import { storeArtifact } from "../artifacts/artifact-index.js";
import type { ArtifactIndex } from "../artifacts/artifact-index.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { HpathDb } from "../db/index.js";
import { grpcError, toGrpcError } from "./errors.js";

const CHUNK_SIZE = 64 * 1024;

/** kernel verdict (execute-agent schema) -> proto Verdict. Unknown entry
 * shapes degrade to empty strings rather than throwing: a malformed verdict
 * must still fail the run, not crash the stream. */
export function mapKernelVerdict(kernel: KernelVerdict): Verdict {
  const entries = Array.isArray(kernel.alignments) ? kernel.alignments : [];
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    status:
      kernel.status === "pass"
        ? VerdictStatus.VERDICT_STATUS_PASSED
        : VerdictStatus.VERDICT_STATUS_FAILED,
    summary: str(kernel.summary),
    evidence: entries.map((entry) => {
      const alignment = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      return {
        apiPath: str(alignment.apiPath),
        uiAnchor: str(alignment.uiAnchor),
        rule: str(alignment.rule),
        apiObserved: str(alignment.api),
        uiObserved: str(alignment.ui),
        match: alignment.match === true,
        notes: str(alignment.notes),
      };
    }),
  };
}

/** Persisted Env -> kernel EnvBinding: the web base URL becomes the browser's
 * origin fence, the gRPC address becomes the conventional `grpc_target`
 * variable, and vars + credentials are exposed to the system prompt as-is
 * (plaintext in the 1.0 spike). Mirrors the shape tests use (DEMO_ENV). */
export function buildEnvBinding(env: Env): EnvBinding {
  const variables: Record<string, string> = { ...env.vars, ...env.credentials };
  if (env.grpcAddress) {
    variables.grpc_target = env.grpcAddress;
  }
  return {
    projectId: env.projectId,
    envId: env.id,
    name: env.name,
    baseUrl: env.webBaseUrl,
    variables,
  };
}

/** Persisted Case -> execute-agent input (its inputSchema: caseId, goal,
 * one {rule} entry per alignment). The agent decides the how; the case only
 * states what to verify. */
export function buildRunInput(kase: Case): Record<string, unknown> {
  return {
    caseId: kase.id,
    goal: kase.goal,
    alignments: kase.alignments.map((alignment) => ({ rule: alignment.rule })),
  };
}

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "step";
}

function padSeq(seq: number): string {
  return String(seq).padStart(2, "0");
}

/** Dependencies the real run handlers need; assembled once per server. */
export interface RunExecutionDeps {
  db: HpathDb;
  kernel: AgentKernel;
  artifactStore: ArtifactStore;
  artifactIndex: ArtifactIndex;
}

/**
 * Streams kernel events to the client and SQLite while the run executes, and
 * redirects binary evidence (screenshots now, video/trace after settle) to
 * the artifact store. The gRPC write side stops on client cancel; the SQLite
 * side keeps consuming until the run settles so evidence is never dropped.
 */
class RunEventBridge {
  private readonly queue: AgentRunEvent[] = [];
  private notify?: () => void;
  private settled = false;
  private nextSeq = 1;

  constructor(
    private readonly deps: RunExecutionDeps,
    private readonly run: Run,
    private readonly call: ServerWritableStream<RunCaseRequest, Event>,
  ) {}

  /** The sink handed to the kernel: in-memory collection (the pipeline reads
   * events() back for the run result) fanned out into the live queue. The
   * forward sink assigns its own seq — append order is identical, so the
   * numbering matches the in-memory copy. */
  createSink(): AgentEventSink {
    const inMemory = new InMemoryEventSink({ runId: this.run.id });
    const forward = {
      seq: 1,
      append: (payload: AgentRunEventPayload): void => {
        this.queue.push({
          runId: this.run.id,
          seq: forward.seq++,
          timestamp: new Date().toISOString(),
          payload,
        });
        this.notify?.();
      },
      events: (): AgentRunEvent[] => [],
    };
    return new CompositeEventSink([inMemory, forward]);
  }

  /** Resolve once the kernel has settled (all queued events drained). */
  private waitForSettle(): Promise<void> {
    if (this.settled && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.notify = () => {
        if (this.settled && this.queue.length === 0) {
          this.notify = undefined;
          resolve();
        }
      };
    });
  }

  settle(): void {
    this.settled = true;
    this.notify?.();
  }

  private waitForEvent(): Promise<void> {
    if (this.queue.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.notify = () => {
        this.notify = undefined;
        resolve();
      };
    });
  }

  /** Consume queued events in order until the run settles. */
  async drain(): Promise<void> {
    for (;;) {
      while (this.queue.length === 0) {
        if (this.settled) return;
        await this.waitForEvent();
      }
      const agentEvent = this.queue.shift()!;
      const protoEvent = await this.toProtoEvent(agentEvent);
      if (!protoEvent) continue;
      try {
        this.deps.db.events.append(protoEvent);
      } catch (err) {
        // Evidence must survive: an event log failure is logged, not fatal —
        // the client still sees the event and the run continues.
        console.error("[hpath-server] event append failed:", err);
      }
      if (!this.call.cancelled) {
        this.call.write(protoEvent);
      }
    }
  }

  /** kernel payload -> proto Event. Returns undefined for kernel-internal
   * kinds the proto contract has no branch for (evidence entries and case
   * drafts surface through the verdict / PRD flows instead). The seq counter
   * only advances for events actually emitted, so the stream keeps a gapless
   * 1-based numbering. */
  private async toProtoEvent(agentEvent: AgentRunEvent): Promise<Event | undefined> {
    const payload = agentEvent.payload;
    const base = (): { runId: string; seq: number; timestamp: string } => ({
      runId: this.run.id,
      seq: this.nextSeq++,
      timestamp: agentEvent.timestamp,
    });
    switch (payload.kind) {
      case "run_status":
        return { ...base(), runStatus: { status: payload.status, reason: payload.reason } };
      case "agent_text":
        return { ...base(), agentText: { text: payload.text } };
      case "agent_thinking":
        return { ...base(), agentThinking: { text: payload.text } };
      case "tool_started":
        return { ...base(), toolStarted: { tool: payload.tool, argsJson: payload.argsJson } };
      case "tool_finished":
        return {
          ...base(),
          toolFinished: {
            tool: payload.tool,
            ok: payload.ok,
            resultSummary: payload.resultSummary,
            artifactId: "",
          },
        };
      case "request_record":
        return {
          ...base(),
          requestRecord: {
            direction: payload.direction,
            method: payload.method,
            target: payload.target,
            requestJson: payload.requestJson,
            responseJson: payload.responseJson,
          },
        };
      case "verdict":
        return { ...base(), verdict: mapKernelVerdict(payload.verdict) };
      case "screenshot": {
        // Binary evidence goes to the artifact store; the stream only carries
        // the artifact reference (proto screenshot has no inline bytes).
        try {
          const artifact = await storeArtifact(this.deps.artifactStore, this.deps.artifactIndex, {
            projectId: this.run.projectId,
            envId: this.run.envId,
            runId: this.run.id,
            name: `${padSeq(agentEvent.seq)}-${sanitizeName(payload.label)}.png`,
            kind: ArtifactKind.ARTIFACT_KIND_SCREENSHOT,
            body: Buffer.from(payload.base64, "base64"),
          });
          return { ...base(), screenshot: { artifactId: artifact.id, caption: payload.label } };
        } catch (err) {
          return {
            ...base(),
            error: {
              kind: "artifact_upload",
              message: `screenshot "${payload.label}" could not be stored: ${(err as Error).message}`,
            },
          };
        }
      }
      case "error":
        return { ...base(), error: { kind: payload.errorKind, message: payload.message } };
      case "evidence_recorded":
      case "case_draft_recorded":
        return undefined;
    }
  }

  /** Upload the providers' pending by-products (video/trace). Failures are
   * logged, never fatal: incomplete evidence must not fail a finished run. */
  async uploadPendingArtifacts(result: AgentRunResult): Promise<void> {
    for (const pending of result.pendingArtifacts) {
      try {
        if (!existsSync(pending.path)) continue;
        await storeArtifact(this.deps.artifactStore, this.deps.artifactIndex, {
          projectId: this.run.projectId,
          envId: this.run.envId,
          runId: this.run.id,
          name: pending.name,
          kind: pending.kind as ArtifactKind,
          body: createReadStream(pending.path),
        });
      } catch (err) {
        console.error(`[hpath-server] artifact "${pending.name}" upload failed:`, err);
      }
    }
    const dirs = new Set(
      result.pendingArtifacts.map((artifact) => artifact.cleanupDir).filter((dir): dir is string => Boolean(dir)),
    );
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp dir is a cosmetic leak, not a run failure.
      }
    }
  }
}

/**
 * The real runCase handler. Terminal writes (verdict + final run_status) come
 * from the kernel's settle path, so the event order matches the mock:
 * RUNNING -> ... -> verdict -> PASSED/FAILED.
 */
export function createRunCaseHandler(deps: RunExecutionDeps) {
  return (call: ServerWritableStream<RunCaseRequest, Event>): void => {
    void (async () => {
      let run: Run | undefined;
      try {
        const req = call.request;
        deps.db.projects.getRequired(req.projectId);
        const env = deps.db.envs.get(req.envId);
        if (!env || env.projectId !== req.projectId) {
          throw grpcError(status.NOT_FOUND, `env not found in project: ${req.envId}`);
        }
        const kase = deps.db.cases.get(req.caseId);
        if (!kase || kase.projectId !== req.projectId) {
          throw grpcError(status.NOT_FOUND, `case not found in project: ${req.caseId}`);
        }
        if (kase.status !== CaseStatus.CASE_STATUS_APPROVED) {
          throw grpcError(status.FAILED_PRECONDITION, "only APPROVED cases can run");
        }

        run = {
          id: randomUUID(),
          projectId: req.projectId,
          envId: req.envId,
          caseId: req.caseId,
          status: RunStatus.RUN_STATUS_RUNNING,
          trigger:
            req.trigger === RunTrigger.RUN_TRIGGER_UNSPECIFIED
              ? RunTrigger.RUN_TRIGGER_MANUAL
              : req.trigger,
          startedAt: new Date().toISOString(),
          finishedAt: "",
          durationMs: 0,
          tokenCost: 0,
          failReason: "",
        };
        deps.db.runs.create(run);

        const bridge = new RunEventBridge(deps, run, call);
        const drainPromise = bridge.drain();
        let result: AgentRunResult;
        try {
          result = await deps.kernel.run({
            agentId: EXECUTE_AGENT_ID,
            runId: run.id,
            input: buildRunInput(kase),
            env: buildEnvBinding(env),
            sink: bridge.createSink(),
          });
        } finally {
          bridge.settle();
        }
        await drainPromise;

        await bridge.uploadPendingArtifacts(result);
        deps.db.runs.finish(run.id, {
          status: result.status,
          verdict: result.verdict ? mapKernelVerdict(result.verdict) : undefined,
          finishedAt: result.finishedAt,
          durationMs: result.durationMs,
          tokenCost: result.tokenCost,
          failReason: result.failReason,
        });
        if (!call.cancelled) call.end();
      } catch (err) {
        // A hard failure after the run row was created must not strand a
        // RUNNING run: settle it as failed so history stays queryable.
        if (run) {
          try {
            deps.db.runs.finish(run.id, {
              status: RunStatus.RUN_STATUS_FAILED,
              finishedAt: new Date().toISOString(),
              durationMs: 0,
              tokenCost: 0,
              failReason: "agent_error",
            });
          } catch {
            // Swallowed: the original error is reported below.
          }
        }
        call.emit("error", toGrpcError(err));
      }
    })();
  };
}

/** Real getRun: the run plus its ordered events and artifact index rows. */
export function createGetRunHandler(deps: RunExecutionDeps) {
  return (
    call: ServerUnaryCall<GetRunRequest, RunDetail>,
    callback: sendUnaryData<RunDetail>,
  ): void => {
    try {
      const run: Run = deps.db.runs.getRequired(call.request.runId);
      callback(null, {
        run,
        events: deps.db.events.listForRun(run.id),
        artifacts: deps.db.artifacts.listForRun(run.id),
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };
}

/** Real downloadArtifact: stream the stored object in 64 KiB chunks. */
export function createDownloadArtifactHandler(deps: RunExecutionDeps) {
  return (call: ServerWritableStream<DownloadArtifactRequest, BytesChunk>): void => {
    void (async () => {
      try {
        const artifact: Artifact | undefined = deps.db.artifacts.get(call.request.artifactId);
        if (!artifact) {
          throw grpcError(status.NOT_FOUND, `artifact not found: ${call.request.artifactId}`);
        }
        const object = await deps.artifactStore.getObject(artifact.key);
        const reader = object.stream[Symbol.asyncIterator]();
        for (;;) {
          if (call.cancelled) return;
          const { done, value } = await reader.next();
          if (done) break;
          const chunk = value as Uint8Array;
          for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_SIZE) {
            if (call.cancelled) return;
            const end = Math.min(offset + CHUNK_SIZE, chunk.byteLength);
            call.write({ data: Buffer.from(chunk.subarray(offset, end)) });
          }
        }
        call.end();
      } catch (err) {
        call.emit("error", toGrpcError(err));
      }
    })();
  };
}
