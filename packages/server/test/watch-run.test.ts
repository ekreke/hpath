// T21 live view: WatchRun handler tests — real mode (mid-run subscribe, frame
// delivery, hub teardown on settle, NOT_FOUND, settled-run empty stream) and
// the mock handler's synthetic-frame parity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import type { ServerWritableStream } from "@grpc/grpc-js";
import {
  CaseStatus,
  CreatorType,
  RunStatus,
  RunTrigger,
  type Case,
  type Env,
  type Event,
  type Project,
  type Run,
  type RunFrame,
  type WatchRunRequest,
} from "@hpath/contract";
import { HpathDb } from "../src/db/index.js";
import { LocalArtifactStore } from "../src/artifacts/store.js";
import { ArtifactIndex } from "../src/artifacts/artifact-index.js";
import { RunFrameHubRegistry } from "../src/agents/frames.js";
import type { AgentKernel } from "../src/agents/pipeline.js";
import {
  createRunCaseHandler,
  createWatchRunHandler,
  type RunExecutionDeps,
} from "../src/grpc/run-execution.js";
import { createMockHandlers } from "../src/mock/handlers.js";
import { createMockStore } from "../src/mock/store.js";

function seedWorld(db: HpathDb): { project: Project; env: Env; kase: Case } {
  const now = new Date().toISOString();
  const project = db.projects.create({ id: randomUUID(), name: `proj-${randomUUID().slice(0, 8)}`, repoUrl: "", createdAt: now });
  const env = db.envs.create({
    id: randomUUID(),
    projectId: project.id,
    name: "dev",
    webBaseUrl: "http://localhost:8081",
    grpcAddress: "",
    vars: {},
    credentials: {},
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

function fakeFrameStream(request: WatchRunRequest): {
  call: ServerWritableStream<WatchRunRequest, RunFrame>;
  frames: RunFrame[];
  errors: { code: number; details: string }[];
  ended: () => boolean;
} {
  const frames: RunFrame[] = [];
  const errors: { code: number; details: string }[] = [];
  let endCalled = false;
  const call = {
    request,
    cancelled: false,
    write: (frame: RunFrame) => {
      frames.push(frame);
    },
    end: () => {
      endCalled = true;
    },
    emit: (name: string, err: { code: number; details: string }) => {
      if (name === "error") errors.push(err);
      return true;
    },
  } as unknown as ServerWritableStream<WatchRunRequest, RunFrame>;
  return { call, frames, errors, ended: () => endCalled };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeDeps(db: HpathDb, kernel: AgentKernel): { deps: RunExecutionDeps; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hpath-watchrun-"));
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

test("real watchRun: mid-run subscriber receives frames; the stream ends when the run settles", async () => {
  const db = HpathDb.inMemory();
  const { project, env, kase } = seedWorld(db);
  let releaseRun: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  // The kernel parks on the gate until the watcher has subscribed, then
  // publishes exactly one frame before finishing the run.
  const kernel = {
    run: async (runOptions: { runId: string; agentId: string; frames?: { publish: (data: Uint8Array, mime?: string) => number | undefined } }) => {
      await gate;
      runOptions.frames?.publish(Uint8Array.from([1, 2, 3]));
      return {
        runId: runOptions.runId,
        agentId: runOptions.agentId,
        status: RunStatus.RUN_STATUS_PASSED,
        verdict: { status: "pass", summary: "ok", alignments: [] },
        failReason: "",
        tokenCost: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        events: [],
        pendingArtifacts: [],
      };
    },
  } as unknown as AgentKernel;
  const { deps, cleanup } = makeDeps(db, kernel);
  try {
    createRunCaseHandler(deps)({
      request: { projectId: project.id, envId: env.id, caseId: kase.id, trigger: RunTrigger.RUN_TRIGGER_MANUAL },
      cancelled: false,
      write: () => {},
      end: () => {},
      emit: () => true,
    } as unknown as ServerWritableStream<{ projectId: string; envId: string; caseId: string; trigger: RunTrigger }, Event>);
    await waitFor(() => db.runs.list({ projectId: project.id }).length > 0, "the run row");
    const runId = db.runs.list({ projectId: project.id })[0].id;

    const watch = fakeFrameStream({ runId });
    createWatchRunHandler(deps)(watch.call);
    await waitFor(
      () => deps.frameHubs.get(runId)?.subscriberCount === 1,
      "the watcher to subscribe",
    );
    releaseRun();

    await waitFor(() => watch.ended(), "the watch stream to end");
    assert.equal(watch.errors.length, 0);
    assert.equal(watch.frames.length, 1, "exactly the frame published mid-run");
    assert.equal(watch.frames[0].runId, runId);
    assert.equal(watch.frames[0].seq, 1);
    assert.equal(watch.frames[0].mime, "image/jpeg");
    assert.deepEqual(Array.from(watch.frames[0].data), [1, 2, 3]);
    // The hub is torn down with the run: no further watchers.
    assert.equal(deps.frameHubs.get(runId), undefined);
  } finally {
    cleanup();
    db.close();
  }
});

test("real watchRun: unknown run id is NOT_FOUND", async () => {
  const db = HpathDb.inMemory();
  const { deps, cleanup } = makeDeps(db, {} as AgentKernel);
  try {
    const watch = fakeFrameStream({ runId: "missing" });
    createWatchRunHandler(deps)(watch.call);
    await waitFor(() => watch.errors.length > 0, "the NOT_FOUND error");
    assert.equal(watch.errors[0].code, status.NOT_FOUND);
  } finally {
    cleanup();
    db.close();
  }
});

test("real watchRun: a run without an active hub ends the stream empty", async () => {
  const db = HpathDb.inMemory();
  const { project, env, kase } = seedWorld(db);
  const run: Run = {
    id: randomUUID(),
    projectId: project.id,
    envId: env.id,
    caseId: kase.id,
    status: RunStatus.RUN_STATUS_PASSED,
    trigger: RunTrigger.RUN_TRIGGER_MANUAL,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 5,
    tokenCost: 0,
    failReason: "",
  };
  db.runs.create(run);
  const { deps, cleanup } = makeDeps(db, {} as AgentKernel);
  try {
    const watch = fakeFrameStream({ runId: run.id });
    createWatchRunHandler(deps)(watch.call);
    await waitFor(() => watch.ended(), "the immediate stream end");
    assert.equal(watch.frames.length, 0);
    assert.equal(watch.errors.length, 0);
  } finally {
    cleanup();
    db.close();
  }
});

test("mock watchRun: synthetic frames until the run settles; unknown run NOT_FOUND", async () => {
  const store = createMockStore();
  const run: Run = {
    id: "r-live",
    projectId: "p1",
    envId: "e1",
    caseId: "c1",
    status: RunStatus.RUN_STATUS_RUNNING,
    trigger: RunTrigger.RUN_TRIGGER_MANUAL,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "",
    durationMs: 0,
    tokenCost: 0,
    failReason: "",
  };
  store.runs.set(run.id, run);
  const handlers = createMockHandlers(store);

  const watch = fakeFrameStream({ runId: run.id });
  handlers.watchRun(watch.call);
  await waitFor(() => watch.frames.length >= 2, "two synthetic frames");
  assert.equal(watch.frames[0].mime, "image/jpeg");
  assert.ok(watch.frames[0].data.byteLength > 0);
  assert.equal(watch.frames[1].seq, watch.frames[0].seq + 1, "frame seq increments");

  run.status = RunStatus.RUN_STATUS_PASSED;
  await waitFor(() => watch.ended(), "the stream end after the terminal status");

  const missing = fakeFrameStream({ runId: "nope" });
  handlers.watchRun(missing.call);
  await waitFor(() => missing.errors.length > 0, "the NOT_FOUND error");
  assert.equal(missing.errors[0].code, status.NOT_FOUND);
});
