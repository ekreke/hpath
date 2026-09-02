// Scripted execution of a mock run. Produces the same event shape the real
// executor agent will emit (T7b/T8): thinking, tool calls, screenshots,
// request records, verdict, status changes.
//
// delayMs = 0 runs instantly (used to build seed history); delayMs > 0 streams
// events with pauses (used by the live RunCase handler).

import { randomUUID } from "node:crypto";
import type {
  Case,
  Env,
  Event,
  Project,
  Run,
  RunTrigger,
  Verdict,
} from "@hpath/contract";
import { ArtifactKind, RunStatus, VerdictStatus } from "@hpath/contract";
import type { MockStore } from "./store.js";
import { nowIso } from "./store.js";
import {
  makePng,
  makeRequestLog,
  makeTraceZip,
  makeVideoPlaceholder,
  registerArtifact,
} from "./artifacts.js";

export type RunOutcome = "pass" | "fail" | "limit";

export interface SimulateRunOptions {
  store: MockStore;
  project: Project;
  env: Env;
  kase: Case;
  trigger: RunTrigger;
  outcome: RunOutcome;
  /** pause between events in ms; 0 = instant (seed mode) */
  delayMs: number;
  /** called for every event while streaming live runs */
  onEvent?: (event: Event) => void;
}

interface Exchange {
  method: string;
  target: string;
  request: unknown;
  response: unknown;
}

function baseEvent(runId: string, seq: number, timestamp: string): Event {
  return { runId, seq, timestamp };
}

function fakeDuration(outcome: RunOutcome): number {
  if (outcome === "pass") return 8400;
  if (outcome === "fail") return 11200;
  return 4300;
}

export async function simulateRun(options: SimulateRunOptions): Promise<Run> {
  const { store, project, env, kase, trigger, outcome, delayMs, onEvent } = options;

  const run: Run = {
    id: randomUUID(),
    projectId: project.id,
    envId: env.id,
    caseId: kase.id,
    status: RunStatus.RUN_STATUS_RUNNING,
    trigger,
    verdict: undefined,
    startedAt: nowIso(),
    finishedAt: "",
    durationMs: 0,
    tokenCost: 0,
    failReason: "",
  };
  store.runs.set(run.id, run);

  const events: Event[] = store.events.get(run.id) ?? [];
  store.events.set(run.id, events);
  const exchanges: Exchange[] = [];
  let seq = 0;
  let tokenCost = 320;

  const push = (partial: Omit<Event, "runId" | "seq" | "timestamp">): void => {
    seq += 1;
    tokenCost += 40;
    const event: Event = { ...baseEvent(run.id, seq, nowIso()), ...partial };
    events.push(event);
    onEvent?.(event);
  };

  const sleep = async (): Promise<void> => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };

  push({ runStatus: { status: RunStatus.RUN_STATUS_RUNNING, reason: "" } });
  await sleep();
  push({
    agentThinking: {
      text: `Read case "${kase.title}". Goal: ${kase.goal} Plan: open the app, observe the UI, call the interfaces, compare all three sides.`,
    },
  });
  await sleep();

  if (outcome === "limit") {
    push({
      toolStarted: { tool: "navigate", argsJson: JSON.stringify({ url: env.webBaseUrl }) },
    });
    await sleep();
    push({
      error: { kind: "limit:max_steps", message: "Mock step budget exhausted before verdict." },
    });
    push({ runStatus: { status: RunStatus.RUN_STATUS_FAILED, reason: "limit:max_steps" } });
    run.status = RunStatus.RUN_STATUS_FAILED;
    run.failReason = "limit:max_steps";
    run.tokenCost = tokenCost;
    run.durationMs = fakeDuration(outcome);
    run.finishedAt = nowIso();
    return run;
  }

  push({
    toolStarted: { tool: "navigate", argsJson: JSON.stringify({ url: env.webBaseUrl }) },
  });
  await sleep();
  push({
    toolFinished: { tool: "navigate", ok: true, resultSummary: `Opened ${env.webBaseUrl}`, artifactId: "" },
  });
  const loginShot = registerArtifact(store, run, project, env, ArtifactKind.ARTIFACT_KIND_SCREENSHOT, "01-login.png", makePng(320, 240, [48, 96, 160]));
  push({ screenshot: { artifactId: loginShot.id, caption: "Login page rendered" } });
  await sleep();

  push({
    agentText: { text: `Login page loaded. Observing UI anchor "${kase.alignments[0]?.uiAnchor ?? "dashboard"}".` },
  });
  await sleep();

  const balanceUrl = `${env.webBaseUrl.replace(/\/$/, "")}/api/balance`;
  push({
    toolStarted: {
      tool: "http_request",
      argsJson: JSON.stringify({ method: "GET", url: balanceUrl }),
    },
  });
  await sleep();
  exchanges.push({
    method: "GET",
    target: balanceUrl,
    request: { headers: { accept: "application/json" } },
    response: { status: 200, body: { balance: "1000.00", currency: "USD" } },
  });
  push({
    toolFinished: {
      tool: "http_request",
      ok: true,
      resultSummary: 'HTTP 200 {"balance":"1000.00"}',
      artifactId: "",
    },
  });
  push({
    requestRecord: {
      direction: "http",
      method: "GET",
      target: balanceUrl,
      requestJson: JSON.stringify({ headers: { accept: "application/json" } }),
      responseJson: JSON.stringify({ status: 200, body: { balance: "1000.00", currency: "USD" } }),
    },
  });
  await sleep();

  push({
    toolStarted: {
      tool: "grpc_call",
      argsJson: JSON.stringify({ address: env.grpcAddress, method: "BalanceService/GetBalance" }),
    },
  });
  await sleep();
  const grpcResponse = outcome === "fail" ? { balance: "998.00", currency: "USD" } : { balance: "1000.00", currency: "USD" };
  exchanges.push({
    method: "BalanceService/GetBalance",
    target: env.grpcAddress,
    request: { accountId: "demo" },
    response: grpcResponse,
  });
  push({
    toolFinished: {
      tool: "grpc_call",
      ok: true,
      resultSummary: `gRPC OK ${JSON.stringify(grpcResponse)}`,
      artifactId: "",
    },
  });
  push({
    requestRecord: {
      direction: "grpc",
      method: "BalanceService/GetBalance",
      target: env.grpcAddress,
      requestJson: JSON.stringify({ accountId: "demo" }),
      responseJson: JSON.stringify(grpcResponse),
    },
  });
  await sleep();

  push({
    agentThinking: { text: "Comparing API response with the UI display against the alignment rules." },
  });
  await sleep();
  push({
    toolStarted: { tool: "read_page", argsJson: JSON.stringify({ anchor: kase.alignments[0]?.uiAnchor ?? "" }) },
  });
  await sleep();
  const uiObserved = outcome === "fail" ? "Balance card shows 998.00 USD" : "Balance card shows 1000.00 USD";
  push({
    toolFinished: {
      tool: "read_page",
      ok: true,
      resultSummary: uiObserved,
      artifactId: "",
    },
  });
  const dashShot = registerArtifact(store, run, project, env, ArtifactKind.ARTIFACT_KIND_SCREENSHOT, "02-dashboard.png", makePng(320, 240, [160, 96, 48]));
  push({ screenshot: { artifactId: dashShot.id, caption: "Dashboard balance card" } });
  await sleep();

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
      apiObserved: 'GET /api/balance -> 1000.00; gRPC -> ' + grpcResponse.balance,
      uiObserved,
      match: outcome === "pass",
      notes: outcome === "pass" ? "" : "Backend grpc/dev data drift",
    })),
  };
  push({ toolStarted: { tool: "finish_verdict", argsJson: JSON.stringify({ status: verdict.status }) } });
  await sleep();
  push({ toolFinished: { tool: "finish_verdict", ok: true, resultSummary: verdict.summary, artifactId: "" } });
  push({ verdict });
  push({
    runStatus: {
      status: outcome === "pass" ? RunStatus.RUN_STATUS_PASSED : RunStatus.RUN_STATUS_FAILED,
      reason: outcome === "pass" ? "" : "alignment mismatch",
    },
  });

  registerArtifact(store, run, project, env, ArtifactKind.ARTIFACT_KIND_VIDEO, "session.webm", makeVideoPlaceholder());
  registerArtifact(store, run, project, env, ArtifactKind.ARTIFACT_KIND_TRACE, "trace.zip", makeTraceZip(run.id));
  registerArtifact(store, run, project, env, ArtifactKind.ARTIFACT_KIND_REQUEST_LOG, "requests.json", makeRequestLog(run.id, exchanges));

  run.status = outcome === "pass" ? RunStatus.RUN_STATUS_PASSED : RunStatus.RUN_STATUS_FAILED;
  run.verdict = verdict;
  run.failReason = outcome === "pass" ? "" : "alignment mismatch";
  run.tokenCost = tokenCost;
  run.durationMs = fakeDuration(outcome);
  run.finishedAt = nowIso();
  return run;
}
