// Seed data for the mock store: one demo project, two envs, three cases
// (two approved, one pending agent draft) and two finished runs (one passed,
// one failed) so the desktop history/replay views have data on first boot.

import { randomUUID } from "node:crypto";
import type { Case, Env, Project } from "@hpath/contract";
import { CaseStatus, CreatorType, RunTrigger } from "@hpath/contract";
import type { MockStore } from "./store.js";
import { nowIso } from "./store.js";
import { simulateRun } from "./run-script.js";

export function seedMockStore(store: MockStore): void {
  const project: Project = {
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
    credentials: { account: "test/123456" },
  };
  const staging: Env = {
    id: randomUUID(),
    projectId: project.id,
    name: "staging",
    webBaseUrl: "http://localhost:8082",
    grpcAddress: "localhost:9092",
    vars: { region: "staging" },
    credentials: { account: "qa/abcdef" },
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
  store.cases.set(loginCase.id, loginCase);
  store.cases.set(transferCase.id, transferCase);
  store.cases.set(ordersDraft.id, ordersDraft);

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
