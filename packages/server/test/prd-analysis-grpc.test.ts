// Real-mode ParsePRD wiring (T9) unit tests: the parsePrd handler over an
// in-memory database, a stub kernel (scripted events, no LLM) and a local
// artifact store. The analyze-agent kernel itself (md/docx/pdf ingest,
// stamped drafts, hard limits) is covered by test/analyze-agent.test.ts;
// this suite pins the gRPC layer: validation, PRD persistence, event
// mapping and the pass/fail settle semantics.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert0 from "node:assert/strict";
import { describe, it } from "node:test";
import { status } from "@grpc/grpc-js";
import type { ServerWritableStream } from "@grpc/grpc-js";
import {
  CaseStatus,
  CreatorType,
  PrdFormat,
  RunStatus,
  type Case,
  type ParseEvent,
  type ParsePRDRequest,
  type Project,
} from "@hpath/contract";
import { InMemoryEventSink } from "../src/agents/events.js";
import type { AgentEventSink } from "../src/agents/events.js";
import { RunFrameHubRegistry } from "../src/agents/frames.js";
import type { AgentKernel } from "../src/agents/pipeline.js";
import type {
  AgentRunEventPayload,
  AgentRunResult,
} from "../src/agents/types.js";
import { LocalArtifactStore, readAll } from "../src/artifacts/store.js";
import { ArtifactIndex } from "../src/artifacts/artifact-index.js";
import { isValidArtifactKey } from "../src/artifacts/keys.js";
import { HpathDb } from "../src/db/index.js";
import { createParsePrdHandler } from "../src/grpc/prd-analysis.js";
import type { RunExecutionDeps } from "../src/grpc/run-execution.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MD_CONTENT = "# Orders\n\nThe dashboard lists the user's orders.\n";

function makeProject(db: HpathDb): Project {
  return db.projects.create({
    id: randomUUID(),
    name: `proj-${randomUUID().slice(0, 8)}`,
    repoUrl: "",
    createdAt: new Date().toISOString(),
  });
}

/** A stamped draft in the proto Case shape, as the analyze-agent's verdict
 * carries them (kernel-stamped by write_case_draft). */
function stampedDraft(projectId: string, runId: string, title: string): Case {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId,
    title,
    goal: `Verify "${title}" through three-way alignment`,
    alignments: [
      { apiPath: "/api/orders", uiAnchor: "orders table", rule: "UI rows equal the API response" },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "analyze-agent", runRef: `analyze-run#${runId}` },
    status: CaseStatus.CASE_STATUS_PENDING,
    sourcePrdRef: "orders.md#order-list",
    version: 1,
    changelog: [
      { version: 1, author: "analyze-agent", comment: "Drafted from PRD by analyze-agent", changedAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

interface ScriptedKernelOptions {
  payloads: AgentRunEventPayload[];
  result?: Partial<AgentRunResult>;
  crash?: Error;
}

/** A kernel stub: replays scripted payloads through the run's sink and
 * returns a canned result. No LLM, fully deterministic. */
function stubKernel(options: ScriptedKernelOptions): AgentKernel {
  return {
    run: async (runOptions: { runId: string; agentId: string; input: unknown; sink?: AgentEventSink }) => {
      if (options.crash) throw options.crash;
      const sink: AgentEventSink = runOptions.sink ?? new InMemoryEventSink({ runId: runOptions.runId });
      for (const payload of options.payloads) {
        sink.append(payload);
      }
      return {
        runId: runOptions.runId,
        agentId: runOptions.agentId,
        status: RunStatus.RUN_STATUS_PASSED,
        verdict: { summary: "ok", drafts: [] },
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

function makeDeps(db: HpathDb, kernel: AgentKernel): { deps: RunExecutionDeps; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hpath-prdanalysis-"));
  return {
    deps: {
      db,
      kernel,
      artifactStore: new LocalArtifactStore(dir),
      artifactIndex: new ArtifactIndex(db.artifacts),
      frameHubs: new RunFrameHubRegistry(),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeStream(request: ParsePRDRequest): {
  call: ServerWritableStream<ParsePRDRequest, ParseEvent>;
  events: ParseEvent[];
  errors: { code: number; details: string }[];
  ended: () => boolean;
} {
  const events: ParseEvent[] = [];
  const errors: { code: number; details: string }[] = [];
  let endCalled = false;
  const call = {
    request,
    cancelled: false,
    write: (event: ParseEvent) => {
      events.push(event);
    },
    end: () => {
      endCalled = true;
    },
    emit: (name: string, err: { code: number; details: string }) => {
      if (name === "error") errors.push(err);
      return true;
    },
  } as unknown as ServerWritableStream<ParsePRDRequest, ParseEvent>;
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

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("real parsePrd handler — validation", () => {
  it("rejects an unknown project with NOT_FOUND", async () => {
    const db = HpathDb.inMemory();
    const { deps, cleanup } = makeDeps(db, stubKernel({ payloads: [] }));
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: "no-such-project",
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_MD,
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(stream.call);
      await waitFor(() => stream.errors.length > 0, "the stream error");
      assert.equal(stream.errors[0].code, status.NOT_FOUND);
    } finally {
      cleanup();
      db.close();
    }
  });

  it("rejects empty content and a missing filename with INVALID_ARGUMENT", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    const { deps, cleanup } = makeDeps(db, stubKernel({ payloads: [] }));
    try {
      const handler = createParsePrdHandler(deps);
      const empty = fakeStream({
        projectId: project.id,
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_MD,
        content: Buffer.alloc(0),
      });
      handler(empty.call);
      await waitFor(() => empty.errors.length > 0, "the empty-content error");
      assert.equal(empty.errors[0].code, status.INVALID_ARGUMENT);

      const unnamed = fakeStream({
        projectId: project.id,
        filename: "",
        format: PrdFormat.PRD_FORMAT_MD,
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(unnamed.call);
      await waitFor(() => unnamed.errors.length > 0, "the missing-filename error");
      assert.equal(unnamed.errors[0].code, status.INVALID_ARGUMENT);
    } finally {
      cleanup();
      db.close();
    }
  });

  it("rejects an undeterminable format (no enum, no extension) with INVALID_ARGUMENT", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    const { deps, cleanup } = makeDeps(db, stubKernel({ payloads: [] }));
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        filename: "spec.txt",
        format: PrdFormat.PRD_FORMAT_UNSPECIFIED,
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(stream.call);
      await waitFor(() => stream.errors.length > 0, "the format error");
      assert.equal(stream.errors[0].code, status.INVALID_ARGUMENT);
    } finally {
      cleanup();
      db.close();
    }
  });

  it("rejects content over the 20 MB upload cap with INVALID_ARGUMENT", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    const { deps, cleanup } = makeDeps(db, stubKernel({ payloads: [] }));
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_UNSPECIFIED,
        content: Buffer.alloc(20 * 1024 * 1024 + 1),
      });
      handler(stream.call);
      await waitFor(() => stream.errors.length > 0, "the size-cap error");
      assert.equal(stream.errors[0].code, status.INVALID_ARGUMENT);
      assert.equal([...db.prds.listByProject(project.id)].length, 0, "no PRD row for rejected input");
    } finally {
      cleanup();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("real parsePrd handler — analyze run", () => {
  it("registers the PRD, streams mapped events, persists verdict drafts and ends with drafts_created", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    db.cases.create({
      id: randomUUID(),
      projectId: project.id,
      title: "Existing login case",
      goal: "Login works",
      alignments: [{ apiPath: "", uiAnchor: "", rule: "login rule" }],
      creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "human", runRef: "" },
      status: CaseStatus.CASE_STATUS_APPROVED,
      sourcePrdRef: "",
      version: 1,
      changelog: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const seenInputs: unknown[] = [];
    const kernel = {
      run: async (runOptions: { runId: string; agentId: string; input: unknown; sink?: AgentEventSink }) => {
        seenInputs.push(runOptions.input);
        const sink: AgentEventSink = runOptions.sink ?? new InMemoryEventSink({ runId: runOptions.runId });
        const runId = runOptions.runId;
        sink.append({ kind: "run_status", status: RunStatus.RUN_STATUS_RUNNING, reason: "" });
        sink.append({ kind: "agent_text", text: "Reading the PRD." });
        sink.append({ kind: "agent_thinking", text: "Plan: extract behaviors." });
        sink.append({ kind: "tool_started", tool: "read_prd", argsJson: "{}" });
        sink.append({ kind: "tool_finished", tool: "read_prd", ok: true, resultSummary: "1234 chars" });
        sink.append({ kind: "tool_started", tool: "write_case_draft", argsJson: "{}" });
        sink.append({ kind: "tool_finished", tool: "write_case_draft", ok: true, resultSummary: "recorded" });
        sink.append({ kind: "case_draft_recorded", draft: stampedDraft(project.id, runId, "D1") as unknown as Record<string, unknown> });
        sink.append({ kind: "verdict", verdict: { summary: "ok" } });
        sink.append({ kind: "run_status", status: RunStatus.RUN_STATUS_PASSED, reason: "" });
        return {
          runId,
          agentId: "analyze-agent",
          status: RunStatus.RUN_STATUS_PASSED,
          verdict: {
            summary: "ok",
            drafts: [
              stampedDraft(project.id, runId, "Draft one"),
              stampedDraft(project.id, runId, "Draft two"),
            ],
          },
          failReason: "",
          tokenCost: 42,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          durationMs: 1000,
          events: sink.events(),
          pendingArtifacts: [],
        } satisfies AgentRunResult;
      },
    } as unknown as AgentKernel;

    const { deps, cleanup } = makeDeps(db, kernel);
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_UNSPECIFIED, // resolved from the extension
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(stream.call);
      await waitFor(() => stream.ended() || stream.errors.length > 0, "the stream to end");
      assert.equal(stream.errors.length, 0);

      // Kernel input: raw bytes (base64 round-trip) + the existing case list.
      const input = seenInputs[0] as {
        projectId: string;
        filename: string;
        format: string;
        contentBase64: string;
        existingCases: { title: string }[];
      };
      assert.equal(input.projectId, project.id);
      assert.equal(input.filename, "orders.md");
      assert.equal(input.format, "md", "format resolved from the filename when unspecified");
      assert.equal(Buffer.from(input.contentBase64, "base64").toString("utf8"), MD_CONTENT);
      assert.deepEqual(input.existingCases, [{ title: "Existing login case", goal: "Login works" }]);

      // Event order: prd_registered -> thinking/progress (mapped) -> drafts_created.
      const kinds = stream.events.map((event) => Object.keys(event)[0]);
      assert.equal(kinds[0], "prdRegistered");
      assert.equal(kinds[kinds.length - 1], "draftsCreated");
      const registered = (stream.events[0] as { prdRegistered: { prd: { format: PrdFormat; sizeBytes: number; contentRef: string } } }).prdRegistered.prd;
      assert.equal(registered.format, PrdFormat.PRD_FORMAT_MD, "resolved format echoed on the Prd row");
      assert.equal(registered.sizeBytes, Buffer.byteLength(MD_CONTENT));
      assert.ok(isValidArtifactKey(registered.contentRef), "content_ref is a valid store key");

      // The raw bytes round-trip from the store under the recorded key.
      const stored = await deps.artifactStore.getObject(registered.contentRef);
      const bytes = await readAll(stored.stream);
      assert.equal(bytes.toString("utf8"), MD_CONTENT);

      // thinking + progress mapping (mock-parity cadence).
      const thinking = stream.events.filter((event) => event.thinking !== undefined);
      assert.deepEqual(
        thinking.map((event) => event.thinking!.text),
        ["Reading the PRD.", "Plan: extract behaviors."],
      );
      const progress = stream.events.filter((event) => event.progress !== undefined);
      const pcts = progress.map((event) => event.progress!.pct);
      assert.ok(pcts.includes(30), "read_prd finish maps to 30% (mock parity)");
      assert.ok(pcts.includes(70), "write_case_draft finish maps to 70% (mock parity)");

      // No run_status/verdict/draft/evidence internals leak onto the stream.
      assert.equal(stream.events.filter((event) => event.draftsCreated !== undefined).length, 1);
      assert.equal(stream.events.filter((event) => event.error !== undefined).length, 0);

      // Drafts persisted as pending, agent-created, traceable to the analyze run.
      const created = (stream.events[stream.events.length - 1] as { draftsCreated: { cases: Case[] } }).draftsCreated.cases;
      assert.equal(created.length, 2);
      const runId = registered.contentRef ? (registered as unknown as { id: string }).id : "";
      for (const kase of created) {
        const storedCase = db.cases.getRequired(kase.id);
        assert.equal(storedCase.status, CaseStatus.CASE_STATUS_PENDING);
        assert.equal(storedCase.creator!.type, CreatorType.CREATOR_TYPE_AGENT);
        assert.equal(storedCase.creator!.name, "analyze-agent");
        assert.ok(storedCase.creator!.runRef.startsWith("analyze-run#"));
        void runId;
      }
      assert.deepEqual(
        db.cases.listByProject(project.id, CaseStatus.CASE_STATUS_PENDING).map((kase) => kase.title).sort(),
        ["Draft one", "Draft two"],
      );
    } finally {
      cleanup();
      db.close();
    }
  });

  it("covers all three PRD formats (md/docx/pdf), echoing the resolved format", async () => {
    for (const [filename, format] of [
      ["orders.md", PrdFormat.PRD_FORMAT_MD],
      ["orders.docx", PrdFormat.PRD_FORMAT_DOCX],
      ["orders.pdf", PrdFormat.PRD_FORMAT_PDF],
    ] as const) {
      const db = HpathDb.inMemory();
      const project = makeProject(db);
      const runId = randomUUID();
      const { deps, cleanup } = makeDeps(
        db,
        stubKernel({
          payloads: [{ kind: "agent_text", text: "analyzing" }],
          result: { verdict: { summary: "ok", drafts: [stampedDraft(project.id, runId, `${format} draft`)] } },
        }),
      );
      try {
        const handler = createParsePrdHandler(deps);
        const stream = fakeStream({
          projectId: project.id,
          filename,
          format: PrdFormat.PRD_FORMAT_UNSPECIFIED,
          content: Buffer.from(MD_CONTENT, "utf8"),
        });
        handler(stream.call);
        await waitFor(() => stream.ended() || stream.errors.length > 0, `the ${format} stream to end`);
        assert.equal(stream.errors.length, 0, `${format} must parse`);
        const registered = (stream.events[0] as { prdRegistered: { prd: { format: PrdFormat } } }).prdRegistered.prd;
        assert.equal(registered.format, format);
        const created = (stream.events[stream.events.length - 1] as { draftsCreated: { cases: Case[] } }).draftsCreated.cases;
        assert.equal(created.length, 1, `${format} produces its pending draft`);
      } finally {
        cleanup();
        db.close();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("real parsePrd handler — failure settle", () => {
  it("a FAILED run (hard-limit breach) persists no drafts and ends with a structured error", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({
        payloads: [
          { kind: "agent_text", text: "reading" },
          // Evidence recorded before the breach survives on the stream…
          { kind: "case_draft_recorded", draft: stampedDraft(project.id, "run-x", "Lost draft") as unknown as Record<string, unknown> },
        ],
        result: {
          status: RunStatus.RUN_STATUS_FAILED,
          failReason: "limit:max_steps",
          verdict: undefined,
        },
      }),
    );
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_MD,
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(stream.call);
      await waitFor(() => stream.ended() || stream.errors.length > 0, "the stream to end");
      assert.equal(stream.errors.length, 0, "failure is a stream event, not a gRPC error");

      // The PRD row is still registered (the upload itself succeeded)…
      assert.equal(db.prds.listByProject(project.id).length, 1);
      // …but the last event is the structured error and no case exists.
      const last = stream.events[stream.events.length - 1];
      assert.equal(last.error!.kind, "limit:max_steps");
      assert.equal(stream.events.filter((event) => event.draftsCreated !== undefined).length, 0);
      assert.deepEqual(db.cases.listByProject(project.id), []);
    } finally {
      cleanup();
      db.close();
    }
  });

  it("a kernel crash reports an error event without corrupting the stream", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({ payloads: [], crash: new Error("kernel exploded") }),
    );
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_MD,
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(stream.call);
      await waitFor(() => stream.ended() || stream.errors.length > 0, "the stream outcome");
      // The catch-all maps the crash onto the stream error channel…
      assert.equal(stream.errors.length, 1);
      // …and no case row is created.
      assert.deepEqual(db.cases.listByProject(project.id), []);
    } finally {
      cleanup();
      db.close();
    }
  });

  it("a failed artifact-store upload degrades to an empty content_ref and still analyzes", async () => {
    const db = HpathDb.inMemory();
    const project = makeProject(db);
    const runId = randomUUID();
    const { deps, cleanup } = makeDeps(
      db,
      stubKernel({
        payloads: [],
        result: { verdict: { summary: "ok", drafts: [stampedDraft(project.id, runId, "Resilient draft")] } },
      }),
    );
    // Break only the upload: every other store operation is irrelevant here.
    deps.artifactStore.putObject = async () => {
      throw new Error("disk full");
    };
    try {
      const handler = createParsePrdHandler(deps);
      const stream = fakeStream({
        projectId: project.id,
        filename: "orders.md",
        format: PrdFormat.PRD_FORMAT_MD,
        content: Buffer.from(MD_CONTENT, "utf8"),
      });
      handler(stream.call);
      await waitFor(() => stream.ended() || stream.errors.length > 0, "the stream to end");
      assert.equal(stream.errors.length, 0);
      const registered = (stream.events[0] as { prdRegistered: { prd: { contentRef: string } } }).prdRegistered.prd;
      assert.equal(registered.contentRef, "", "upload failure leaves content_ref empty");
      const created = (stream.events[stream.events.length - 1] as { draftsCreated: { cases: Case[] } }).draftsCreated.cases;
      assert.equal(created.length, 1, "the analysis still completes");
    } finally {
      cleanup();
      db.close();
    }
  });
});
