// First-boot seed data for the real (non-mock) server mode (T3).
//
// Mirrors the mock seed (src/mock/seed.ts + run-script.ts): one demo project,
// envs dev + staging, five cases (four approved — including the scripted-outcome
// probes "hard-limit" and "alignment-drift" — plus one pending agent draft) and
// two finished runs (one passed, one failed) with their event transcripts.
//
// Seeding runs exactly once: seedDatabase() skips any database that already
// has projects. Run artifacts (video/trace/screenshots) are deliberately NOT
// seeded — their bytes live in the artifact store, which lands with T6/T8.

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Case, Env, Event, Prd, Project, Run, Verdict } from "@hpath/contract";
import {
  CaseStatus,
  CreatorType,
  PrdFormat,
  RunStatus,
  RunTrigger,
  VerdictStatus,
} from "@hpath/contract";
import type { HpathDb } from "./index.js";
import { withTransaction } from "./database.js";

/** Everything the seed created, so tests and callers can reference the ids. */
export interface SeedResult {
  project: Project;
  envs: { dev: Env; staging: Env };
  cases: {
    login: Case;
    transfer: Case;
    ordersDraft: Case;
    limitProbe: Case;
    drift: Case;
  };
  runs: { passed: Run; failed: Run };
  prds: Prd[];
}

// ---------------------------------------------------------------------------
// Fixture PRDs (fixtures/prds/, one per PRD format)
// ---------------------------------------------------------------------------

const PRD_FIXTURES: ReadonlyArray<{ filename: string; format: PrdFormat }> = [
  { filename: "payment.md", format: PrdFormat.PRD_FORMAT_MD },
  { filename: "payment.docx", format: PrdFormat.PRD_FORMAT_DOCX },
  { filename: "orders.pdf", format: PrdFormat.PRD_FORMAT_PDF },
];

/** Directory of this module: <server>/src or <server>/dist depending on build. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled fixtures/prds directory. Walks up from this module
 * directory until a fixtures/prds is found, which works for both the src/
 * (tsx) and dist/ (compiled) layouts regardless of nesting depth, then falls
 * back to a cwd-relative path for exotic layouts.
 */
export function prdFixturesDir(): string {
  let dir = MODULE_DIR;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "fixtures", "prds");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return resolve("fixtures", "prds");
}

function seedPrds(db: HpathDb, projectId: string, clock: SeedClock): Prd[] {
  const dir = prdFixturesDir();
  const prds: Prd[] = [];
  let index = 0;
  for (const fixture of PRD_FIXTURES) {
    const path = join(dir, fixture.filename);
    if (!existsSync(path)) {
      console.warn(`[hpath-server] seed: fixture PRD missing, skipping: ${path}`);
      continue;
    }
    const prd: Prd = {
      id: randomUUID(),
      projectId,
      filename: fixture.filename,
      format: fixture.format,
      sizeBytes: statSync(path).size,
      // Staggered by 1ms so listByProject (ORDER BY created_at, id) is
      // deterministic despite random ids.
      createdAt: clock.at(index),
      // Storage keys land with the artifact store (T6); for the bundled
      // fixtures the repo-relative path is a stable, human-readable ref.
      contentRef: `fixtures/prds/${fixture.filename}`,
    };
    db.prds.insert(prd);
    prds.push(prd);
    index += 1;
  }
  return prds;
}

// ---------------------------------------------------------------------------
// Seed content (mirrors src/mock/seed.ts)
// ---------------------------------------------------------------------------

interface SeedClock {
  /** Base instant; everything is derived from it so ordering is stable. */
  at(offsetMs: number): string;
}

function makeClock(base: Date): SeedClock {
  return { at: (offsetMs: number) => new Date(base.getTime() + offsetMs).toISOString() };
}

function seedProject(db: HpathDb, clock: SeedClock): Project {
  const project: Project = {
    id: randomUUID(),
    name: "demo-bank",
    repoUrl: "https://github.com/example/demo-bank",
    createdAt: clock.at(0),
  };
  db.projects.create(project);
  return project;
}

function seedEnvs(db: HpathDb, project: Project): { dev: Env; staging: Env } {
  const dev: Env = {
    id: randomUUID(),
    projectId: project.id,
    name: "dev",
    webBaseUrl: "http://localhost:8081",
    grpcAddress: "localhost:9091",
    vars: { region: "local" },
    // Credentials baked into the demo-app fixture (its login page displays
    // them). Wrong values here cost the agent real steps against the step
    // budget, so they must match the SUT exactly.
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
    // Same demo-app credentials; the staging instance only differs in seed
    // balance. dev/staging share the login, not the data.
    credentials: { username: "demo", password: "demo1234" },
    isDefault: false,
  };
  db.envs.create(dev);
  db.envs.create(staging);
  return { dev, staging };
}

function seedCases(db: HpathDb, project: Project, clock: SeedClock): SeedResult["cases"] {
  // createdAt staggered by 1ms per case so listByProject (ORDER BY created_at)
  // returns the same stable order as the mock's insertion order.
  const t = (i: number): string => clock.at(i);

  const login: Case = {
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
    changelog: [{ version: 1, author: "john", comment: "Initial version", changedAt: t(0) }],
    createdAt: t(0),
    updatedAt: t(0),
  };
  const transfer: Case = {
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
      { version: 1, author: "john", comment: "Initial version", changedAt: t(0) },
      { version: 2, author: "alice", comment: "Added transfer toast alignment", changedAt: t(0) },
    ],
    createdAt: t(1),
    updatedAt: t(1),
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
    changelog: [{ version: 1, author: "analyze-agent", comment: "Drafted from PRD", changedAt: t(2) }],
    createdAt: t(2),
    updatedAt: t(2),
  };
  // Scripted-outcome probes (T12): the mock's title-keyword convention turns
  // these into the hard-limit and alignment-fail demo paths.
  const limitProbe: Case = {
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
    changelog: [{ version: 1, author: "john", comment: "Hard-limit probe", changedAt: t(3) }],
    createdAt: t(3),
    updatedAt: t(3),
  };
  const drift: Case = {
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
    changelog: [{ version: 1, author: "alice", comment: "Drift probe", changedAt: t(4) }],
    createdAt: t(4),
    updatedAt: t(4),
  };

  for (const kase of [login, transfer, ordersDraft, limitProbe, drift]) {
    db.cases.create(kase);
  }
  return { login, transfer, ordersDraft, limitProbe, drift };
}

// ---------------------------------------------------------------------------
// Sample runs with event transcripts (mirrors src/mock/run-script.ts)
// ---------------------------------------------------------------------------

function durationFor(outcome: "pass" | "fail"): number {
  return outcome === "pass" ? 8400 : 11200;
}

function eventTimestamps(startedAt: Date, count: number, durationMs: number): string[] {
  const step = durationMs / Math.max(count - 1, 1);
  return Array.from({ length: count }, (_, i) => new Date(startedAt.getTime() + i * step).toISOString());
}

/**
 * Build the event transcript for a finished run. Same payload kinds as the
 * mock's simulateRun, minus screenshot events (they reference artifact ids of
 * the artifact store, which does not exist until T6).
 */
function buildRunEvents(
  runId: string,
  env: Env,
  kase: Case,
  outcome: "pass" | "fail",
  timestamps: string[],
): Event[] {
  const base = (seq: number): Pick<Event, "runId" | "seq" | "timestamp"> => ({
    runId,
    seq,
    timestamp: timestamps[seq - 1] ?? timestamps[0],
  });
  const balanceUrl = `${env.webBaseUrl.replace(/\/$/, "")}/api/balance`;
  const grpcResponse = outcome === "pass"
    ? { balance: "1000.00", currency: "USD" }
    : { balance: "998.00", currency: "USD" };
  const uiObserved = outcome === "pass"
    ? "Balance card shows 1000.00 USD"
    : "Balance card shows 998.00 USD";
  const verdict: Verdict = {
    status: outcome === "pass" ? VerdictStatus.VERDICT_STATUS_PASSED : VerdictStatus.VERDICT_STATUS_FAILED,
    summary:
      outcome === "pass"
        ? "HTTP, gRPC and UI all report the same balance; alignment rules satisfied."
        : "gRPC reports 998.00 while HTTP and UI report 1000.00; three-way alignment broken.",
    evidence: kase.alignments.map((alignment) => ({
      apiPath: alignment.apiPath,
      uiAnchor: alignment.uiAnchor,
      rule: alignment.rule,
      apiObserved: "GET /api/balance -> 1000.00; gRPC -> " + grpcResponse.balance,
      uiObserved,
      match: outcome === "pass",
      notes: outcome === "pass" ? "" : "Backend grpc/dev data drift",
    })),
  };

  const payloads: Array<Omit<Event, "runId" | "seq" | "timestamp">> = [
    { runStatus: { status: RunStatus.RUN_STATUS_RUNNING, reason: "" } },
    {
      agentThinking: {
        text: `Read case "${kase.title}". Goal: ${kase.goal} Plan: open the app, observe the UI, call the interfaces, compare all three sides.`,
      },
    },
    { toolStarted: { tool: "navigate", argsJson: JSON.stringify({ url: env.webBaseUrl }) } },
    { toolFinished: { tool: "navigate", ok: true, resultSummary: `Opened ${env.webBaseUrl}`, artifactId: "" } },
    {
      agentText: { text: `Login page loaded. Observing UI anchor "${kase.alignments[0]?.uiAnchor ?? "dashboard"}".` },
    },
    { toolStarted: { tool: "http_request", argsJson: JSON.stringify({ method: "GET", url: balanceUrl }) } },
    {
      toolFinished: {
        tool: "http_request",
        ok: true,
        resultSummary: 'HTTP 200 {"balance":"1000.00"}',
        artifactId: "",
      },
    },
    {
      requestRecord: {
        direction: "http",
        method: "GET",
        target: balanceUrl,
        requestJson: JSON.stringify({ headers: { accept: "application/json" } }),
        responseJson: JSON.stringify({ status: 200, body: { balance: "1000.00", currency: "USD" } }),
      },
    },
    {
      toolStarted: {
        tool: "grpc_call",
        argsJson: JSON.stringify({ address: env.grpcAddress, method: "BalanceService/GetBalance" }),
      },
    },
    {
      toolFinished: {
        tool: "grpc_call",
        ok: true,
        resultSummary: `gRPC OK ${JSON.stringify(grpcResponse)}`,
        artifactId: "",
      },
    },
    {
      requestRecord: {
        direction: "grpc",
        method: "BalanceService/GetBalance",
        target: env.grpcAddress,
        requestJson: JSON.stringify({ accountId: "demo" }),
        responseJson: JSON.stringify(grpcResponse),
      },
    },
    { agentThinking: { text: "Comparing API response with the UI display against the alignment rules." } },
    { toolStarted: { tool: "read_page", argsJson: JSON.stringify({ anchor: kase.alignments[0]?.uiAnchor ?? "" }) } },
    { toolFinished: { tool: "read_page", ok: true, resultSummary: uiObserved, artifactId: "" } },
    { toolStarted: { tool: "finish_verdict", argsJson: JSON.stringify({ status: verdict.status }) } },
    { toolFinished: { tool: "finish_verdict", ok: true, resultSummary: verdict.summary, artifactId: "" } },
    { verdict },
    {
      runStatus: {
        status: outcome === "pass" ? RunStatus.RUN_STATUS_PASSED : RunStatus.RUN_STATUS_FAILED,
        reason: outcome === "pass" ? "" : "alignment mismatch",
      },
    },
  ];
  return payloads.map((payload, i) => ({ ...base(i + 1), ...payload }));
}

function seedRun(
  db: HpathDb,
  project: Project,
  env: Env,
  kase: Case,
  trigger: RunTrigger,
  outcome: "pass" | "fail",
  startedAt: Date,
): Run {
  const durationMs = durationFor(outcome);
  const timestamps = eventTimestamps(startedAt, 18, durationMs);
  // The run's verdict rides on the transcript's verdict event; build the
  // transcript first with a placeholder id, then attach the real run id.
  const events = buildRunEvents("", env, kase, outcome, timestamps);
  const run: Run = {
    id: randomUUID(),
    projectId: project.id,
    envId: env.id,
    caseId: kase.id,
    status: outcome === "pass" ? RunStatus.RUN_STATUS_PASSED : RunStatus.RUN_STATUS_FAILED,
    trigger,
    verdict: events.find((event) => event.verdict)?.verdict,
    startedAt: timestamps[0],
    finishedAt: timestamps[timestamps.length - 1],
    durationMs,
    // Mirrors the mock script's accounting: 320 base + 40 per event.
    tokenCost: 320 + 40 * events.length,
    failReason: outcome === "pass" ? "" : "alignment mismatch",
  };
  db.runs.create(run);
  for (const event of events) {
    db.events.append({ ...event, runId: run.id });
  }
  return run;
}

function seedRuns(
  db: HpathDb,
  project: Project,
  envs: { dev: Env; staging: Env },
  cases: SeedResult["cases"],
  base: Date,
): { passed: Run; failed: Run } {
  const passed = seedRun(
    db,
    project,
    envs.dev,
    cases.login,
    RunTrigger.RUN_TRIGGER_MANUAL,
    "pass",
    new Date(base.getTime() - 2 * 60 * 60 * 1000),
  );
  const failed = seedRun(
    db,
    project,
    envs.staging,
    cases.transfer,
    RunTrigger.RUN_TRIGGER_AGENT,
    "fail",
    new Date(base.getTime() - 1 * 60 * 60 * 1000),
  );
  return { passed, failed };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Seed demo data into a fresh database. No-op (returns undefined) when the
 * database already contains projects, so reboots never duplicate the seed.
 * The whole seed runs in one transaction: a mid-way failure rolls everything
 * back, leaving the database empty so the next boot can re-seed cleanly.
 */
export function seedDatabase(db: HpathDb): SeedResult | undefined {
  if (db.projects.list().length > 0) {
    return undefined;
  }
  return withTransaction(db.database, () => {
    const base = new Date();
    const clock = makeClock(base);
    const project = seedProject(db, clock);
    const envs = seedEnvs(db, project);
    const cases = seedCases(db, project, clock);
    const runs = seedRuns(db, project, envs, cases, base);
    const prds = seedPrds(db, project.id, clock);
    return { project, envs, cases, runs, prds };
  });
}
