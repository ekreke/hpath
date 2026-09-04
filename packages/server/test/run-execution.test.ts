// Real-mode run execution (T8) unit tests: the kernel->proto event mapping,
// env/input builders, and the RunCase handler over an in-memory database, a
// stub kernel (scripted events, no LLM/browser) and a local artifact store.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert0 from "node:assert/strict";
import { describe, it } from "node:test";
import { status } from "@grpc/grpc-js";
import type { ServerWritableStream } from "@grpc/grpc-js";
import {
  ArtifactKind,
  CaseStatus,
  CreatorType,
  RunStatus,
  RunTrigger,
  VerdictStatus,
} from "@hpath/contract";
import type { Case, Env, Event, Project, RunCaseRequest } from "@hpath/contract";
import { InMemoryEventSink } from "../src/agents/events.js";
import type { AgentEventSink } from "../src/agents/events.js";
import type { AgentKernel } from "../src/agents/pipeline.js";
import type {
  AgentRunEventPayload,
  AgentRunResult,
} from "../src/agents/types.js";
import { LocalArtifactStore } from "../src/artifacts/store.js";
import { readAll } from "../src/artifacts/store.js";
import { ArtifactIndex } from "../src/artifacts/artifact-index.js";
import { HpathDb } from "../src/db/index.js";
import {
  buildEnvBinding,
  buildRunInput,
  createDownloadArtifactHandler,
  createGetRunHandler,
  createRunCaseHandler,
  mapKernelVerdict,
  type RunExecutionDeps,
} from "../src/grpc/run-execution.js";

// ---------------------------------------------------------------------------
// Mapping builders
// ---------------------------------------------------------------------------

describe("mapKernelVerdict", () => {
  it("maps a pass verdict with alignment entries", () => {
    const verdict = mapKernelVerdict({
      status: "pass",
      summary: "all three sides agree",
      alignments: [
        { rule: "balance renders", api: `{"balance":"1337.50"}`, ui: "1337.50", match: true, notes: "shot 01" },
      ],
    });
    assert.equal(verdict.status, VerdictStatus.VERDICT_STATUS_PASSED);
    assert.equal(verdict.summary, "all three sides agree");
    assert.equal(verdict.evidence.length, 1);
    assert.equal(verdict.evidence[0].rule, "balance renders");
    assert.equal(verdict.evidence[0].apiObserved, `{"balance":"1337.50"}`);
    assert.equal(verdict.evidence[0].uiObserved, "1337.50");
    assert.equal(verdict.evidence[0].match, true);
    assert.equal(verdict.evidence[0].notes, "shot 01");
  });

  it("maps a fail verdict and degrades malformed entries instead of throwing", () => {
    const verdict = mapKernelVerdict({
      status: "fail",
      summary: 42,
      alignments: ["not-an-object", { rule: "r", api: "a", ui: "u", match: "yes" }],
    });
    assert.equal(verdict.status, VerdictStatus.VERDICT_STATUS_FAILED);
    assert.equal(verdict.summary, "");
    assert.equal(verdict.evidence.length, 2);
    assert.deepEqual(verdict.evidence[0], {
      apiPath: "", uiAnchor: "", rule: "", apiObserved: "", uiObserved: "", match: false, notes: "",
    });
    assert.equal(verdict.evidence[1].rule, "r");
    assert.equal(verdict.evidence[1].match, false);
  });
});

describe("buildEnvBinding / buildRunInput", () => {
  it("binds the web base URL, grpc target and merged variables", () => {
    const binding = buildEnvBinding({
      id: "e1",
      projectId: "p1",
      name: "dev",
      webBaseUrl: "http://localhost:8081",
      grpcAddress: "localhost:9091",
      vars: { region: "eu" },
      credentials: { account: "demo" },
      isDefault: true,
    });
    assert.deepEqual(binding, {
      projectId: "p1",
      envId: "e1",
      name: "dev",
      baseUrl: "http://localhost:8081",
      variables: { region: "eu", account: "demo", grpc_target: "localhost:9091" },
    });
  });

  it("builds the execute-agent input from the case definition", () => {
    const input = buildRunInput({
      id: "c1",
      projectId: "p1",
      title: "Login",
      goal: "Login works end to end",
      alignments: [
        { apiPath: "/api/balance", uiAnchor: "card", rule: "balance equals the seeded value" },
      ],
      creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "test", runRef: "" },
      status: CaseStatus.CASE_STATUS_APPROVED,
      sourcePrdRef: "",
      version: 1,
      changelog: [],
      createdAt: "",
      updatedAt: "",
    });
    assert.deepEqual(input, {
      caseId: "c1",
      goal: "Login works end to end",
      alignments: [{ rule: "balance equals the seeded value" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Handler fixtures
// ---------------------------------------------------------------------------

const PNG_1PX = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function seedWorld(db: HpathDb): { project: Project; env: Env; kase: Case } {
  const now = new Date().toISOString();
  const project = db.projects.create({ id: randomUUID(), name: `proj-${randomUUID().slice(0, 8)}`, repoUrl: "", createdAt: now });
  const env = db.envs.create({
    id: randomUUID(),
    projectId: project.id,
    name: "dev",
    webBaseUrl: "http://localhost:8081",
    grpcAddress: "localhost:9091",
    vars: {},
    credentials: { account: "demo" },
    isDefault: true,
  });
  const kase = db.cases.create({
    id: randomUUID(),
    projectId: project.id,
    title: "Balance shows after login",
    goal: "The dashboard balance equals the seeded value after login",
    alignments: [
      { apiPath: "/api/balance", uiAnchor: "balance card", rule: "balance equals the seeded value" },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "test", runRef: "" },
    status: CaseStatus.CASE_STATUS_APPROVED,
    sourcePrdRef: "",
    version: 1,
    changelog: [],
    createdAt: now,
    updatedAt: now,
  });
  return { project, env, kase };
}

interface ScriptedKernelOptions {
  payloads: AgentRunEventPayload[];
  result?: Partial<AgentRunResult>;
  crash?: Error;
}

/** A kernel stub: replays scripted payloads through the run's sink and
 * returns a canned result. No LLM, no browser, fully deterministic. */
function stubKernel(options: ScriptedKernelOptions): AgentKernel {
  return {
    run: async (runOptions: { runId: string; agentId: string; sink?: AgentEventSink }) => {
      if (options.crash) throw options.crash;
      const sink: AgentEventSink = runOptions.sink ?? new InMemoryEventSink({ runId: runOptions.runId });
      for (const payload of options.payloads) {
        sink.append(payload);
      }
      return {
        runId: runOptions.runId,
        agentId: runOptions.agentId,
        status: RunStatus.RUN_STATUS_PASSED,
        verdict: { status: "pass", summary: "ok", alignments: [] },
        failReason: "",
        tokenCost: 42,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        events: sink.events(),
        pendingArtifacts: [],
        ...options.result,
      };
    },
  } as unknown as AgentKernel;
}

function fakeStream(request: RunCaseRequest): {
  call: ServerWritableStream<RunCaseRequest, Event>;
  events: Event[];
  errors: { code: number; details: string }[];
  ended: () => boolean;
} {
  const events: Event[] = [];
  const errors: { code: number; details: string }[] = [];
  let endCalled = false;
  const call = {
    request,
    cancelled: false,
    write: (event: Event) => {
      events.push(event);
    },
    end: () => {
      endCalled = true;
    },
    emit: (name: string, err: { code: number; details: string }) => {
      if (name === "error") errors.push(err);
      return true;
    },
  } as unknown as ServerWritableStream<RunCaseRequest, Event>;
  return { call, events, errors, ended: () => endCalled };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert0.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeDeps(db: HpathDb, kernel: AgentKernel): { deps: RunExecutionDeps; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hpath-runexec-"));
  return {
    deps: {
      db,
      kernel,
      artifactStore: new LocalArtifactStore(dir),
      artifactIndex: new ArtifactIndex(db.artifacts),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// runCase handler
// ---------------------------------------------------------------------------

describe("real runCase handler", () => {
  it("rejects a non-APPROVED case with FAILED_PRECONDITION", async () => {
    const db = HpathDb.inMemory();
    const { project, env } = seedWorld(db);
    const now = new Date().toISOString();
    const pending = db.cases.create({
      id: randomUUID(),
      projectId: project.id,
      title: "Pending draft",
      goal: "Not approved yet",
      alignments: [{ apiPath: "", uiAnchor: "", rule: "unused" }],
      creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "test", runRef: "" },
      status: CaseStatus.CASE_STATUS_PENDING,
      sourcePrdRef: "",
      version: 1,
      changelog: [],
      createdAt: now,
      updatedAt: now,
    });
    const { deps, cleanup } = makeDeps(db, stubKernel({ payloads: [] }));
    try {
      const handler = createRunCaseHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        envId: env.id,
        caseId: pending.id,
        trigger: RunTrigger.RUN_TRIGGER_MANUAL,
      });
      handler(stream.call);
      await waitFor(() => stream.errors.length > 0, "the stream error");
      assert.equal(stream.errors[0].code, status.FAILED_PRECONDITION);
      assert.deepEqual(db.runs.list({ projectId: project.id }), []);
    } finally {
      cleanup();
      db.close();
    }
  });

  it("streams scripted events in order, uploads screenshots and finishes the run", async () => {
    const db = HpathDb.inMemory();
    const { project, env, kase } = seedWorld(db);
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({
        payloads: [
          { kind: "run_status", status: RunStatus.RUN_STATUS_RUNNING, reason: "" },
          { kind: "agent_text", text: "Opening the login page" },
          { kind: "tool_started", tool: "navigate", argsJson: `{"url":"/login"}` },
          { kind: "tool_finished", tool: "navigate", ok: true, resultSummary: "200" },
          { kind: "request_record", direction: "http", method: "GET", target: "http://localhost:8081/api/balance", requestJson: "{}", responseJson: `{"balance":"1337.50"}` },
          { kind: "screenshot", label: "01-dashboard", mime: "image/png", base64: Buffer.from(PNG_1PX).toString("base64") },
          { kind: "evidence_recorded", entry: { rule: "r" } },
          { kind: "verdict", verdict: { status: "pass", summary: "ok", alignments: [{ rule: "r", api: "a", ui: "u", match: true }] } },
          { kind: "run_status", status: RunStatus.RUN_STATUS_PASSED, reason: "" },
        ],
      }),
    );
    try {
      const handler = createRunCaseHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        envId: env.id,
        caseId: kase.id,
        trigger: RunTrigger.RUN_TRIGGER_MANUAL,
      });
      handler(stream.call);
      await waitFor(() => stream.ended(), "the stream to end");

      // Event order matches the script (evidence_recorded has no proto branch
      // and is skipped); the screenshot became an artifact reference.
      assert.deepEqual(
        stream.events.map((event) => Object.keys(event).filter((key) => !["runId", "seq", "timestamp"].includes(key))[0]),
        [
          "runStatus", "agentText", "toolStarted", "toolFinished",
          "requestRecord", "screenshot", "verdict", "runStatus",
        ],
      );
      assert.deepEqual(
        stream.events.map((event, index) => event.seq),
        stream.events.map((_, index) => index + 1),
        "seq must be gapless and 1-based",
      );
      const screenshot = stream.events.find((event) => event.screenshot)!;
      assert.ok(screenshot.screenshot!.artifactId.length > 0);
      assert.equal(screenshot.screenshot!.caption, "01-dashboard");

      // The screenshot bytes landed in the artifact store + index.
      const artifacts = db.artifacts.listForRun(stream.events[0].runId);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].kind, ArtifactKind.ARTIFACT_KIND_SCREENSHOT);
      const stored = await deps.artifactStore.getObject(artifacts[0].key);
      const bytes = await readAll(stored.stream);
      assert.deepEqual(bytes, Buffer.from(PNG_1PX));

      // Events and the run row are persisted with the terminal verdict.
      const persisted = deps.db.events.listForRun(stream.events[0].runId);
      assert.equal(persisted.length, stream.events.length);
      const run = deps.db.runs.getRequired(stream.events[0].runId);
      assert.equal(run.status, RunStatus.RUN_STATUS_PASSED);
      assert.equal(run.tokenCost, 42);
      assert.equal(run.verdict?.status, VerdictStatus.VERDICT_STATUS_PASSED);
      assert.equal(run.failReason, "");
    } finally {
      cleanup();
      db.close();
    }
  });

  it("keeps evidence and marks the run failed on a limit breach", async () => {
    const db = HpathDb.inMemory();
    const { project, env, kase } = seedWorld(db);
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({
        payloads: [
          { kind: "run_status", status: RunStatus.RUN_STATUS_RUNNING, reason: "" },
          { kind: "agent_text", text: "working..." },
          { kind: "error", errorKind: "limit:max_steps", message: "step budget exhausted" },
          { kind: "run_status", status: RunStatus.RUN_STATUS_FAILED, reason: "limit:max_steps" },
        ],
        result: {
          status: RunStatus.RUN_STATUS_FAILED,
          verdict: undefined,
          failReason: "limit:max_steps",
        },
      }),
    );
    try {
      const handler = createRunCaseHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        envId: env.id,
        caseId: kase.id,
        trigger: RunTrigger.RUN_TRIGGER_MANUAL,
      });
      handler(stream.call);
      await waitFor(() => stream.ended(), "the stream to end");

      const run = deps.db.runs.getRequired(stream.events[0].runId);
      assert.equal(run.status, RunStatus.RUN_STATUS_FAILED);
      assert.equal(run.failReason, "limit:max_steps");
      assert.equal(run.verdict, undefined);
      // Evidence from before the breach survives in the event log.
      assert.ok(deps.db.events.listForRun(run.id).some((event) => event.agentText));
    } finally {
      cleanup();
      db.close();
    }
  });

  it("settles a stranded RUNNING run as failed when the kernel crashes", async () => {
    const db = HpathDb.inMemory();
    const { project, env, kase } = seedWorld(db);
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({ payloads: [], crash: new Error("kernel exploded") }),
    );
    try {
      const handler = createRunCaseHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        envId: env.id,
        caseId: kase.id,
        trigger: RunTrigger.RUN_TRIGGER_MANUAL,
      });
      handler(stream.call);
      await waitFor(() => stream.errors.length > 0, "the stream error");
      const runs = db.runs.list({ projectId: project.id });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, RunStatus.RUN_STATUS_FAILED);
      assert.equal(runs[0].failReason, "agent_error");
    } finally {
      cleanup();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// getRun + downloadArtifact
// ---------------------------------------------------------------------------

describe("real getRun / downloadArtifact handlers", () => {
  it("serves the run with events and artifacts, and streams bytes back", async () => {
    const db = HpathDb.inMemory();
    const { project, env, kase } = seedWorld(db);
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({
        payloads: [{ kind: "screenshot", label: "shot", mime: "image/png", base64: Buffer.from(PNG_1PX).toString("base64") }],
      }),
    );
    try {
      // Produce a run with one artifact through the runCase handler.
      const runHandler = createRunCaseHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        envId: env.id,
        caseId: kase.id,
        trigger: RunTrigger.RUN_TRIGGER_MANUAL,
      });
      runHandler(stream.call);
      await waitFor(() => stream.ended(), "the stream to end");
      const runId = stream.events[0].runId;

      // getRun returns run + events + artifacts.
      const getRun = createGetRunHandler(deps);
      let detail: import("@hpath/contract").RunDetail | null | undefined;
      getRun(
        { request: { runId } } as never,
        (err, response) => {
          assert.equal(err, null);
          detail = response;
        },
      );
      assert.ok(detail, "getRun must return a RunDetail");
      assert.ok(detail.run, "getRun must return the run");
      assert.equal(detail.run.id, runId);
      assert.equal(detail.events.length, stream.events.length);
      assert.equal(detail.artifacts.length, 1);

      // downloadArtifact streams the stored bytes.
      const download = createDownloadArtifactHandler(deps);
      const chunks: Uint8Array[] = [];
      const downloadStream = {
        request: { artifactId: detail.artifacts[0].id },
        cancelled: false,
        write: (chunk: { data: Uint8Array }) => {
          chunks.push(chunk.data);
        },
        end: () => {},
        emit: () => true,
      } as unknown as ServerWritableStream<import("@hpath/contract").DownloadArtifactRequest, import("@hpath/contract").BytesChunk>;
      download(downloadStream);
      await waitFor(() => chunks.length > 0, "the download chunks");
      assert.deepEqual(Buffer.concat(chunks), Buffer.from(PNG_1PX));
    } finally {
      cleanup();
      db.close();
    }
  });
});
