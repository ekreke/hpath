// Mock run script control tests: the scripted run honours the same run state
// machine as the real kernel — PENDING before start, pause/resume at event
// boundaries, and cancel settling as CANCELLED with the evidence so far.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStatus, RunTrigger } from "@hpath/contract";
import { simulateRun, type RunController } from "../src/mock/run-script.js";
import { createMockStore } from "../src/mock/store.js";
import type { Case, Env, Project } from "@hpath/contract";

function seed(): { store: ReturnType<typeof createMockStore>; project: Project; env: Env; kase: Case } {
  const store = createMockStore();
  const project: Project = {
    id: "p1",
    name: "proj",
    repoUrl: "",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const env: Env = {
    id: "e1",
    projectId: project.id,
    name: "dev",
    webBaseUrl: "http://localhost:8081",
    grpcAddress: "localhost:9091",
    vars: {},
    credentials: {},
    isDefault: true,
  };
  const kase: Case = {
    id: "c1",
    projectId: project.id,
    title: "Balance shows after login",
    goal: "balance equals the seeded value",
    alignments: [{ apiPath: "/api/balance", uiAnchor: "balance card", rule: "three-way equal" }],
    status: 3,
    sourcePrdRef: "",
    version: 1,
    changelog: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { store, project, env, kase };
}

function optionsWith(
  parts: ReturnType<typeof seed>,
  extra: { control?: { registry: Map<string, RunController> }; onEvent?: (event: unknown) => void },
) {
  return {
    store: parts.store,
    project: parts.project,
    env: parts.env,
    kase: parts.kase,
    trigger: RunTrigger.RUN_TRIGGER_MANUAL,
    outcome: "pass" as const,
    delayMs: 5,
    ...extra,
  };
}

test("the scripted run persists non-terminal transitions and finishes PASSED", async () => {
  const parts = seed();
  const statuses: number[] = [];
  const run = await simulateRun({
    ...optionsWith(parts, {
      onEvent: (event) => {
        const ev = event as { runStatus?: { status: number } };
        if (ev.runStatus) statuses.push(ev.runStatus.status);
      },
    }),
  });
  assert.equal(run.status, RunStatus.RUN_STATUS_PASSED);
  assert.deepEqual(statuses, [RunStatus.RUN_STATUS_RUNNING, RunStatus.RUN_STATUS_PASSED]);
  assert.equal(run.failReason, "");
});

test("cancel settles the scripted run as CANCELLED", async () => {
  const parts = seed();
  const registry = new Map<string, RunController>();
  const statuses: number[] = [];
  const runPromise = simulateRun({
    ...optionsWith(parts, {
      control: { registry },
      onEvent: (event) => {
        const ev = event as { runStatus?: { status: number } };
        if (ev.runStatus) statuses.push(ev.runStatus.status);
      },
    }),
  });
  // The run is registered while in flight; cancel it right away.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(registry.size >= 1, "the live run registers a controller");
  const controller = [...registry.values()][0];
  controller.cancel();
  const run = await runPromise;

  assert.equal(run.status, RunStatus.RUN_STATUS_CANCELLED);
  assert.equal(run.failReason, "cancelled");
  assert.equal(run.verdict, undefined);
  assert.ok(statuses.includes(RunStatus.RUN_STATUS_CANCELLED), "CANCELLED is streamed");
  assert.equal(registry.size, 0, "the controller is unregistered after settle");
});

test("pause suspends progression and resume completes it", async () => {
  const parts = seed();
  const registry = new Map<string, RunController>();
  const runPromise = simulateRun({ ...optionsWith(parts, { control: { registry } }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const controller = [...registry.values()][0];
  controller.pause();
  assert.throws(() => controller.pause(), /cannot pause twice/);
  const store = parts.store;
  const runId = [...store.runs.keys()][0];
  const frozen = store.events.get(runId)!.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    store.events.get(runId)!.length,
    frozen,
    "no events are pushed while paused",
  );
  controller.resume();
  const run = await runPromise;
  assert.equal(run.status, RunStatus.RUN_STATUS_PASSED);
  assert.equal(registry.size, 0);
});
