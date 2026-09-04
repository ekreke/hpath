// Shared fixture builders for the db layer tests (T5). Entities come fully
// formed, mirroring how the gRPC handlers construct them.

import { randomUUID } from "node:crypto";
import type { Case, Env, Project, Run, Verdict } from "@hpath/contract";
import {
  CaseStatus,
  CreatorType,
  RunStatus,
  RunTrigger,
  VerdictStatus,
} from "@hpath/contract";

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: randomUUID(),
    name: `proj-${randomUUID().slice(0, 8)}`,
    repoUrl: "https://github.com/example/repo",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeEnv(project: Project, overrides: Partial<Env> = {}): Env {
  return {
    id: randomUUID(),
    projectId: project.id,
    name: `env-${randomUUID().slice(0, 8)}`,
    webBaseUrl: "http://localhost:8081",
    grpcAddress: "localhost:9091",
    vars: { region: "local" },
    credentials: { account: "test/123456" },
    isDefault: false,
    ...overrides,
  };
}

export function makeCase(project: Project, overrides: Partial<Case> = {}): Case {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId: project.id,
    title: `case-${randomUUID().slice(0, 8)}`,
    goal: "UI, HTTP and gRPC agree on the balance.",
    alignments: [
      {
        apiPath: "/api/balance",
        uiAnchor: "Dashboard balance card",
        rule: "Values are equal with two decimals.",
      },
    ],
    creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "john", runRef: "" },
    status: CaseStatus.CASE_STATUS_APPROVED,
    sourcePrdRef: "prds/payment.md#balance",
    version: 1,
    changelog: [
      { version: 1, author: "john", comment: "Initial version", changedAt: now },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeRun(
  project: Project,
  env: Env,
  kase: Case,
  overrides: Partial<Run> = {},
): Run {
  return {
    id: randomUUID(),
    projectId: project.id,
    envId: env.id,
    caseId: kase.id,
    status: RunStatus.RUN_STATUS_RUNNING,
    trigger: RunTrigger.RUN_TRIGGER_MANUAL,
    verdict: undefined,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    durationMs: 0,
    tokenCost: 0,
    failReason: "",
    ...overrides,
  };
}

export function passedVerdict(): Verdict {
  return {
    status: VerdictStatus.VERDICT_STATUS_PASSED,
    summary: "All three sides report the same value.",
    evidence: [
      {
        apiPath: "/api/balance",
        uiAnchor: "Dashboard balance card",
        rule: "Values are equal.",
        apiObserved: "1000.00",
        uiObserved: "1000.00",
        match: true,
        notes: "",
      },
    ],
  };
}
