// Seed data for the mock store: one demo project, two envs, five cases
// (four approved — including two scripted-outcome probes: a hard-limit case
// and an alignment-drift case — plus one pending agent draft) and two
// finished runs (one passed, one failed) so the desktop history/replay views
// have data on first boot. Live run outcomes follow the title-keyword
// convention in handlers.ts (outcomeForTitle).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Asset, Case, Env, Project } from "@hpath/contract";
import { AssetType, CaseStatus, CreatorType, RunTrigger } from "@hpath/contract";
import type { MockStore } from "./store.js";
import { nowIso } from "./store.js";
import { simulateRun } from "./run-script.js";
import { parseProtoBundle } from "../assets/proto-doc.js";

export function seedMockStore(store: MockStore): void {  const project: Project = {
    id: randomUUID(),
    name: "demo-bank",
    repoUrl: "https://github.com/example/demo-bank",
    createdAt: nowIso(),
  };
  store.projects.set(project.id, project);

  const dev: Env = {
    id: randomUUID(),
    projectId: project.id,
    name: "dev",
    webBaseUrl: "http://localhost:8081",
    grpcAddress: "localhost:9091",
    vars: { region: "local" },
    // Matches the demo-app fixture's real login so mock and real seed data
    // agree (the execute-agent surfaces these to the LLM).
    credentials: { username: "demo", password: "demo1234" },
    isDefault: true,
  };
  const staging: Env = {
    id: randomUUID(),
    projectId: project.id,
    name: "staging",
    webBaseUrl: "http://localhost:8082",
    grpcAddress: "localhost:9092",
    vars: { region: "staging" },
    credentials: { username: "demo", password: "demo1234" },
    isDefault: false,
  };
  store.envs.set(dev.id, dev);
  store.envs.set(staging.id, staging);

  const loginCase: Case = {
    id: randomUUID(),
    projectId: project.id,
    title: "Login shows the backend balance",
    goal: "After login, the dashboard balance card, /api/balance and BalanceService/GetBalance all report the same value.",
    alignments: [
      {
        apiPath: "/api/balance",
        uiAnchor: "Dashboard balance card",
        rule: "Values are equal and rendered with two decimal places.",
      },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "john", runRef: "" },
    status: CaseStatus.CASE_STATUS_APPROVED,
    sourcePrdRef: "prds/payment.md#balance-display",
    version: 1,
    changelog: [
      { version: 1, author: "john", comment: "Initial version", changedAt: nowIso() },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const transferCase: Case = {
    id: randomUUID(),
    projectId: project.id,
    title: "Transfer updates balance everywhere",
    goal: "After a transfer, the UI, HTTP balance endpoint and gRPC balance service agree on the new balance.",
    alignments: [
      {
        apiPath: "/api/balance",
        uiAnchor: "Dashboard balance card",
        rule: "Balance after transfer matches the API value.",
      },
      {
        apiPath: "/api/transfer",
        uiAnchor: "Transfer confirmation toast",
        rule: "Toast confirms the transferred amount and the new balance.",
      },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "john", runRef: "" },
    status: CaseStatus.CASE_STATUS_APPROVED,
    sourcePrdRef: "prds/payment.md#transfer",
    version: 2,
    changelog: [
      { version: 1, author: "john", comment: "Initial version", changedAt: nowIso() },
      { version: 2, author: "alice", comment: "Added transfer toast alignment", changedAt: nowIso() },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ordersDraft: Case = {
    id: randomUUID(),
    projectId: project.id,
    title: "Order list matches the order service",
    goal: "Orders rendered in the UI are identical to the orders returned by the backend service, following the PRD.",
    alignments: [
      {
        apiPath: "/api/orders",
        uiAnchor: "Order list table",
        rule: "Every order row matches one API record (id, amount, status).",
      },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "analyze-agent", runRef: "analyze-run#seed" },
    status: CaseStatus.CASE_STATUS_PENDING,
    sourcePrdRef: "prds/orders.md#list",
    version: 1,
    changelog: [
      { version: 1, author: "analyze-agent", comment: "Drafted from PRD", changedAt: nowIso() },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  // Scripted-outcome probes (T12): titles drive outcomeForTitle so the live
  // run panel can demo the hard-limit and alignment-fail paths on demand.
  const limitProbeCase: Case = {
    id: randomUUID(),
    projectId: project.id,
    title: "Limit probe hits the hard step budget",
    goal: "Exercise the executor's hard step limit: the run must stop with a limit breach and preserve the evidence collected so far.",
    alignments: [
      {
        apiPath: "/api/balance",
        uiAnchor: "Dashboard balance card",
        rule: "Any drift between the sides must be reported before the budget is exhausted.",
      },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "john", runRef: "" },
    status: CaseStatus.CASE_STATUS_APPROVED,
    sourcePrdRef: "",
    version: 1,
    changelog: [
      { version: 1, author: "john", comment: "Hard-limit probe", changedAt: nowIso() },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const driftCase: Case = {
    id: randomUUID(),
    projectId: project.id,
    title: "Balance drift fails the alignment check",
    goal: "Detect seeded data drift between the UI and the backend balance so the mismatch verdict path is exercised.",
    alignments: [
      {
        apiPath: "/api/balance",
        uiAnchor: "Dashboard balance card",
        rule: "Values are equal and rendered with two decimal places.",
      },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "alice", runRef: "" },
    status: CaseStatus.CASE_STATUS_APPROVED,
    sourcePrdRef: "prds/payment.md#balance-display",
    version: 1,
    changelog: [
      { version: 1, author: "alice", comment: "Drift probe", changedAt: nowIso() },
    ],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.cases.set(loginCase.id, loginCase);
  store.cases.set(transferCase.id, transferCase);
  store.cases.set(limitProbeCase.id, limitProbeCase);
  store.cases.set(driftCase.id, driftCase);
  store.cases.set(ordersDraft.id, ordersDraft);

  seedMockAssets(store, project.id);

  // Seed history: one passed run on dev, one failed run on staging.
  void simulateRun({
    store,
    project,
    env: dev,
    kase: loginCase,
    trigger: RunTrigger.RUN_TRIGGER_MANUAL,
    outcome: "pass",
    delayMs: 0,
  });
  void simulateRun({
    store,
    project,
    env: staging,
    kase: transferCase,
    trigger: RunTrigger.RUN_TRIGGER_AGENT,
    outcome: "fail",
    delayMs: 0,
  });
}

/**
 * Seed the demo project's proto asset (T22): the demo-app balance service
 * parsed into a real API surface so the asset list and (real-mode) agent
 * wiring are demonstrable immediately. Skipped silently when the fixture is
 * missing or unparseable — the mock seed must never fail boot.
 */
function seedMockAssets(store: MockStore, projectId: string): void {
  const dir = mockModuleDir();
  const protoPath = join(dir, "fixtures", "demo-app", "proto", "balance.proto");
  if (!existsSync(protoPath)) {
    return;
  }
  try {
    const content = readFileSync(protoPath);
    const bundle = parseProtoBundle([{ filename: "balance.proto", content }], "balance.proto");
    const asset: Asset = {
      id: randomUUID(),
      projectId,
      type: AssetType.ASSET_TYPE_PROTO,
      filename: "balance.proto",
      sizeBytes: bundle.totalBytes,
      createdAt: nowIso(),
      contentRef: "",
      apiDoc: bundle.apiDoc,
      fileCount: bundle.fileCount,
    };
    store.assets.set(asset.id, asset);
  } catch {
    // Skipped: mock seed robustness beats demo completeness.
  }
}

/** Directory of this module's package root (walks up to fixtures/). */
function mockModuleDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "fixtures"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve("fixtures", "..");
}
