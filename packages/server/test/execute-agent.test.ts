// T7b acceptance: the execute-agent (a registered AgentDefinition) executes a
// seed case against the demo-app dev instance and returns a pass verdict with
// all three evidences (UI / HTTP / gRPC alignment).
//
// OPENAI_API_KEY is unset in this environment, so the model is a *scripted*
// StreamFn — but the tools it drives are the real built-ins: the script reads
// each tool result from the message context and computes the verdict from the
// observed values (real browser via Playwright, real HTTP, real gRPC against
// a locally started demo-app). Real-LLM E2E remains pending manual
// verification (see .lane-status/agents.md).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { RunStatus } from "@hpath/contract";
import {
  ALIGNMENT_ENTRY_SCHEMA,
  AgentKernel,
  AgentRegistry,
  EXECUTE_AGENT_DEFAULT_LIMITS,
  EXECUTE_AGENT_DEFAULT_MODEL,
  EXECUTE_AGENT_ID,
  EXECUTE_AGENT_INPUT_SCHEMA,
  EXECUTE_AGENT_OUTPUT_SCHEMA,
  ToolProviderRegistry,
  assertSchema,
  registerBuiltIns,
  validateSchema,
  type EnvBinding,
  type HardLimits,
} from "../src/agents/index.js";
import {
  DEMO_APP_PROTO,
  DEMO_PASS,
  DEMO_SEED,
  DEMO_SEED_CENTS,
  DEMO_USER,
  startDemoApp,
  type DemoApp,
} from "./helpers/demo-app.js";
import {
  STUB_MODEL,
  assistantToolCallMessage,
  scriptedStreamFn,
  type StreamCallRecord,
} from "./helpers/stub-model.js";

// ── SUT: one dev demo-app instance for this file ────────────────────────────

const app: DemoApp = await startDemoApp();
after(async () => {
  await app.stop();
});

const DEMO_ENV: EnvBinding = {
  projectId: "proj-demo",
  envId: "env-demo-dev",
  name: "dev",
  baseUrl: app.baseUrl,
  variables: {
    grpc_target: app.grpcTarget,
    demo_user: DEMO_USER,
    demo_pass: DEMO_PASS,
    seeded_balance: app.seed,
  },
};

/** The seed case (three-way alignment rules: PRD logic that must hold). */
const SEED_CASE = {
  caseId: "seed-dev-balance-alignment",
  goal: "Log in to the dev demo-app and verify the seeded balance agrees across UI, HTTP and gRPC.",
  alignments: [
    { rule: `The dashboard balance card shows the seeded dev balance (${DEMO_SEED} CNY).` },
    { rule: "GET /api/balance and demo.v1.BalanceService/GetBalance serve the same value as the dashboard." },
    { rule: "All channels identify the serving instance as env dev." },
  ],
};

function makeExecuteAgentKernel(
  streamFn: StreamFn,
  hardLimits: Partial<HardLimits> = {},
): AgentKernel {
  const agents = new AgentRegistry();
  const toolProviders = new ToolProviderRegistry();
  registerBuiltIns(agents, toolProviders, {
    browser: { headless: true },
    grpc: { protoPaths: [DEMO_APP_PROTO], defaultTarget: app.grpcTarget },
    executeAgent: { hardLimits: { timeoutMs: 120_000, ...hardLimits } },
  });
  return new AgentKernel({ agents, toolProviders, streamFn, resolveModel: () => STUB_MODEL });
}

// ── scripted-model plumbing: reads tool results from the message context ────

function toolResultTexts(context: Context, toolName: string): string[] {
  const texts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "toolResult") continue;
    const result = message as ToolResultMessage;
    if (result.toolName === toolName && !result.isError) {
      texts.push(
        result.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join(""),
      );
    }
  }
  return texts;
}

function requireToolResult(context: Context, toolName: string): string {
  const texts = toolResultTexts(context, toolName);
  if (texts.length === 0) throw new Error(`scripted model: no result from ${toolName}`);
  return texts[texts.length - 1];
}

/** Env variables are env-bound into the system prompt; the scripted model reads them there. */
function envVariable(systemPrompt: string, key: string): string {
  const match = new RegExp(`"${key}":"([^"]*)"`).exec(systemPrompt);
  if (!match) throw new Error(`scripted model: env variable "${key}" missing from the system prompt`);
  return match[1];
}

function runInput(context: Context): typeof SEED_CASE {
  const first = context.messages[0];
  if (!first || first.role !== "user") throw new Error("scripted model: no user message");
  const content = (first as { content: unknown }).content;
  const text = typeof content === "string"
    ? content
    : (content as TextContent[]).map((block) => (block.type === "text" ? block.text : "")).join("");
  return JSON.parse(text);
}

interface AlignmentEntry {
  rule: string;
  api: string;
  ui: string;
  match: boolean;
  notes?: string;
  // Tool args flow through the kernel as plain JSON records.
  [key: string]: unknown;
}

/** Three-way alignment judgement computed from REAL tool results of this run. */
function alignmentEntries(context: Context): AlignmentEntry[] {
  const readPages = toolResultTexts(context, "read_page");
  if (readPages.length < 2) throw new Error("scripted model: expected login + dashboard read_page results");
  const loginText = readPages[0];
  const dashboardText = readPages[readPages.length - 1];

  const http = JSON.parse(requireToolResult(context, "http_request")) as {
    body: { env: string; balance: string; balanceCents: number };
  };
  const grpc = JSON.parse(requireToolResult(context, "grpc_call")) as {
    ok: boolean;
    response: { env: string; balance: string; balanceCents: number };
  };

  const uiCentsMatch = /balanceCents=(\d+)/.exec(dashboardText);
  const uiCents = uiCentsMatch ? Number(uiCentsMatch[1]) : NaN;
  const env = http.body.env;

  const balanceEntry: AlignmentEntry = {
    rule: runInput(context).alignments[0].rule,
    api: `GET /api/balance → balance ${http.body.balance} (balanceCents=${http.body.balanceCents})`,
    ui: `dashboard balance card shows ${/¥ [0-9,.]+/.exec(dashboardText)?.[0] ?? "?"}, meta balanceCents=${uiCents}`,
    match: uiCents === http.body.balanceCents,
    notes: "screenshot dashboard-balance",
  };
  const grpcEntry: AlignmentEntry = {
    rule: runInput(context).alignments[1].rule,
    api: `GetBalance → balance ${grpc.response.balance} (balanceCents=${grpc.response.balanceCents})`,
    ui: `dashboard meta balanceCents=${uiCents} (same value rendered on the card)`,
    match: grpc.ok && grpc.response.balanceCents === http.body.balanceCents && uiCents === grpc.response.balanceCents,
  };
  const envEntry: AlignmentEntry = {
    rule: runInput(context).alignments[2].rule,
    api: `GET /api/balance env=${env}; GetBalance env=${grpc.response.env}`,
    ui: `login page shows 当前实例环境：${env}`,
    match: env === grpc.response.env && loginText.includes(`当前实例环境：${env}`),
  };
  return [balanceEntry, grpcEntry, envEntry];
}

/** The scripted execute-agent procedure: drive the real tools, then judge. */
const EXECUTE_SCRIPT = (context: Context, call: number): AssistantMessage => {
  const system = context.systemPrompt ?? "";
  switch (call) {
    case 1: return assistantToolCallMessage("navigate", { url: "/login" });
    case 2: return assistantToolCallMessage("read_page", {});
    case 3: return assistantToolCallMessage("fill", { selector: "#u", value: envVariable(system, "demo_user") });
    case 4: return assistantToolCallMessage("fill", { selector: "#p", value: envVariable(system, "demo_pass") });
    case 5: return assistantToolCallMessage("click", { selector: "#f button[type=submit]" });
    case 6: return assistantToolCallMessage("wait", { selector: "#balance" });
    case 7: return assistantToolCallMessage("read_page", {});
    case 8: return assistantToolCallMessage("screenshot", { label: "dashboard-balance" });
    case 9: return assistantToolCallMessage("http_request", { url: "/api/balance" });
    case 10:
      return assistantToolCallMessage("grpc_call", {
        method: "demo.v1.BalanceService/GetBalance",
        request: { account_id: "seed" },
      });
    case 11: return assistantToolCallMessage("record_evidence", alignmentEntries(context)[0]);
    case 12: return assistantToolCallMessage("record_evidence", alignmentEntries(context)[1]);
    case 13: return assistantToolCallMessage("record_evidence", alignmentEntries(context)[2]);
    case 14: {
      const alignments = alignmentEntries(context);
      const allMatch = alignments.every((entry) => entry.match);
      return assistantToolCallMessage("finish_verdict", {
        status: allMatch ? "pass" : "fail",
        summary: allMatch
          ? "UI, HTTP and gRPC all serve the seeded dev balance; every alignment entry matches."
          : "Misalignment detected between channels; see alignment entries.",
        alignments,
      });
    }
    default:
      throw new Error(`scripted model: unexpected call ${call}`);
  }
};

// ── definition + schema tests ───────────────────────────────────────────────

test("execute-agent is a registered AgentDefinition with the T7b tool surface", () => {
  const agents = new AgentRegistry();
  const toolProviders = new ToolProviderRegistry();
  registerBuiltIns(agents, toolProviders, { grpc: { protoPaths: [DEMO_APP_PROTO] } });

  const definition = agents.require(EXECUTE_AGENT_ID);
  assert.equal(definition.id, "execute-agent");
  assert.deepEqual(definition.toolBindings, ["browser", "http", "grpc"]);
  assert.equal(definition.model, EXECUTE_AGENT_DEFAULT_MODEL);
  assert.deepEqual(definition.hardLimits, EXECUTE_AGENT_DEFAULT_LIMITS);
  // The verdict channel is pipeline machinery, always present.
  for (const providerId of ["browser", "http", "grpc", "evidence"]) {
    assert.ok(toolProviders.require(providerId), `provider ${providerId} registered`);
  }
  // System prompt is a strict template over env + input.
  assert.ok(definition.systemPromptTemplate.includes("{{env.baseUrl}}"));
  assert.ok(definition.systemPromptTemplate.includes("{{input}}"));
});

test("verdict schema validates three-way alignment entries (PRD / UI / backend)", () => {
  const validVerdict = {
    status: "pass",
    summary: "all three channels agree",
    alignments: [
      {
        rule: "the balance matches",
        api: "GET /api/balance → 1337.50",
        ui: "dashboard shows ¥1,337.50",
        match: true,
        notes: "screenshot taken",
      },
      { rule: "env is dev", api: "env=dev", ui: "badge shows dev", match: false },
    ],
  };
  assert.deepEqual(validateSchema(validVerdict, EXECUTE_AGENT_OUTPUT_SCHEMA), []);
  assert.deepEqual(validateSchema(validVerdict.alignments[0], ALIGNMENT_ENTRY_SCHEMA), []);
  assertSchema(validVerdict, EXECUTE_AGENT_OUTPUT_SCHEMA, "verdict");

  // Every alignment entry must carry all three sides.
  const missingUi = {
    status: "pass",
    summary: "s",
    alignments: [{ rule: "r", api: "a", match: true }],
  };
  const missingUiIssues = validateSchema(missingUi, EXECUTE_AGENT_OUTPUT_SCHEMA);
  assert.ok(
    missingUiIssues.some((issue) => issue.path === "alignments.0" && issue.message.includes("ui")),
  );

  // match must be a boolean judgement.
  const stringMatch = {
    status: "pass",
    summary: "s",
    alignments: [{ rule: "r", api: "a", ui: "u", match: "yes" }],
  };
  assert.ok(
    validateSchema(stringMatch, EXECUTE_AGENT_OUTPUT_SCHEMA).some((issue) => issue.path === "alignments.0.match"),
  );

  // At least one alignment entry (minItems 1).
  const noAlignments = { status: "pass", summary: "s", alignments: [] };
  assert.ok(
    validateSchema(noAlignments, EXECUTE_AGENT_OUTPUT_SCHEMA).some((issue) =>
      issue.message.includes("minItems 1"),
    ),
  );

  // status is a strict enum; extra keys are rejected.
  assert.ok(
    validateSchema({ status: "excellent", summary: "s", alignments: [{ rule: "r", api: "a", ui: "u", match: true }] },
      EXECUTE_AGENT_OUTPUT_SCHEMA).some((issue) => issue.path === "status"),
  );
  assert.ok(
    validateSchema({ status: "pass", summary: "s", alignments: [], extra: true },
      EXECUTE_AGENT_OUTPUT_SCHEMA).some((issue) => issue.path === "extra"),
  );
});

test("input schema accepts the seed case shape and rejects broken inputs", () => {
  assert.deepEqual(validateSchema(SEED_CASE, EXECUTE_AGENT_INPUT_SCHEMA), []);
  const missingAlignments = { caseId: "c", goal: "g" };
  assert.ok(
    validateSchema(missingAlignments, EXECUTE_AGENT_INPUT_SCHEMA).some((issue) =>
      issue.message.includes("alignments"),
    ),
  );
  const emptyAlignments = { caseId: "c", goal: "g", alignments: [] };
  assert.ok(
    validateSchema(emptyAlignments, EXECUTE_AGENT_INPUT_SCHEMA).some((issue) =>
      issue.message.includes("minItems 1"),
    ),
  );
});

// ── the acceptance run: execute-agent on the demo-app dev instance ──────────

test("acceptance: execute-agent runs the seed case against demo-app dev — pass verdict + three evidences", async () => {
  const calls: StreamCallRecord[] = [];
  const kernel = makeExecuteAgentKernel(scriptedStreamFn(EXECUTE_SCRIPT, calls));
  const result = await kernel.run({
    agentId: EXECUTE_AGENT_ID,
    input: SEED_CASE,
    env: DEMO_ENV,
  });

  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED, `failReason=${result.failReason}`);
  assert.equal(result.failReason, "");
  assert.equal(result.verdict?.status, "pass");
  const alignments = (result.verdict?.alignments ?? []) as AlignmentEntry[];
  assert.equal(alignments.length, 3, "one evidence per alignment rule");
  assert.ok(alignments.every((entry) => entry.match === true), JSON.stringify(alignments, null, 2));
  assert.ok(alignments.every((entry) => entry.rule.length > 0 && entry.api.length > 0 && entry.ui.length > 0));
  // The verdict was computed from the real seeded value, not hardcoded pass.
  assert.ok(alignments[0].api.includes(DEMO_SEED));
  assert.ok(alignments[0].ui.includes(String(DEMO_SEED_CENTS)));

  // Env-bound injection: credentials travelled through the system prompt.
  assert.ok(calls[0].systemPrompt.includes(DEMO_USER));
  assert.ok(calls[0].systemPrompt.includes(app.grpcTarget));
  assert.ok(calls[0].systemPrompt.includes(DEMO_SEED));
  assert.ok(!calls[0].systemPrompt.includes("staging"));

  // Tool surface actually used: all six browser tools + http + grpc + evidence tools.
  const usedTools = new Set(
    result.events
      .filter((event) => event.payload.kind === "tool_started")
      .map((event) => (event.payload as { tool: string }).tool),
  );
  for (const tool of [
    "navigate", "click", "fill", "read_page", "screenshot", "wait",
    "http_request", "grpc_call", "record_evidence", "finish_verdict",
  ]) {
    assert.ok(usedTools.has(tool), `tool ${tool} should have been used`);
  }

  // Three recorded evidences, all matching.
  const evidenceEvents = result.events.filter((event) => event.payload.kind === "evidence_recorded");
  assert.equal(evidenceEvents.length, 3);
  assert.ok(evidenceEvents.every((event) => (event.payload as unknown as { entry: AlignmentEntry }).entry.match === true));

  // Screenshot evidence kept inline as base64 PNG (T8 moves it to the artifact store).
  const screenshots = result.events.filter((event) => event.payload.kind === "screenshot");
  assert.equal(screenshots.length, 1);
  assert.equal((screenshots[0].payload as { mime: string }).mime, "image/png");
  assert.ok((screenshots[0].payload as { base64: string }).base64.length > 100);

  // Terminal event: run passed through the structured verdict channel.
  const terminal = result.events[result.events.length - 1];
  assert.deepEqual(terminal.payload, { kind: "run_status", status: RunStatus.RUN_STATUS_PASSED, reason: "" });
});

test("a fail verdict is still a successful RUN: the verdict carries the case outcome", async () => {
  const script = (context: Context, call: number): AssistantMessage => {
    if (call === 1) return assistantToolCallMessage("http_request", { url: "/api/balance" });
    if (call === 2) {
      const input = runInput(context);
      return assistantToolCallMessage("record_evidence", {
        rule: input.alignments[0].rule,
        api: "GET /api/balance → balance 0.01 (simulated stale backend)",
        ui: "dashboard shows ¥13,375.00 (simulated stale render)",
        match: false,
      });
    }
    if (call === 3) {
      return assistantToolCallMessage("finish_verdict", {
        status: "fail",
        summary: "channels disagree; see the mismatched alignment entry",
        alignments: alignmentEntriesFromSingle(context),
      });
    }
    throw new Error(`scripted model: unexpected call ${call}`);
  };
  const kernel = makeExecuteAgentKernel(scriptedStreamFn(script));
  const result = await kernel.run({
    agentId: EXECUTE_AGENT_ID,
    input: SEED_CASE,
    env: DEMO_ENV,
  });

  // The run pipeline succeeded (verdict channel is the sole success path);
  // the CASE outcome (fail) lives in the verdict.
  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED);
  assert.equal(result.verdict?.status, "fail");
  const alignments = (result.verdict?.alignments ?? []) as AlignmentEntry[];
  assert.equal(alignments.length, 1);
  assert.equal(alignments[0].match, false);
});

/** Single-entry variant for the fail-verdict script (one honest mismatch entry). */
function alignmentEntriesFromSingle(context: Context): AlignmentEntry[] {
  const input = runInput(context);
  return [{
    rule: input.alignments[0].rule,
    api: "GET /api/balance → balance 0.01 (simulated stale backend)",
    ui: "dashboard shows ¥13,375.00 (simulated stale render)",
    match: false,
  }];
}

test("hard limits still apply to execute-agent: breach preserves recorded evidence", async () => {
  const script = (context: Context, call: number): AssistantMessage => {
    if (call === 1) {
      const input = runInput(context);
      return assistantToolCallMessage("record_evidence", {
        rule: input.alignments[0].rule,
        api: "observed before the breach",
        ui: "observed before the breach",
        match: true,
      });
    }
    return assistantToolCallMessage("navigate", { url: "/login" });
  };
  const kernel = makeExecuteAgentKernel(scriptedStreamFn(script), { maxSteps: 2 });
  const result = await kernel.run({
    agentId: EXECUTE_AGENT_ID,
    input: SEED_CASE,
    env: DEMO_ENV,
  });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "limit:max_steps");
  assert.equal(result.verdict, undefined);
  const evidenceEvents = result.events.filter((event) => event.payload.kind === "evidence_recorded");
  assert.equal(evidenceEvents.length, 1, "evidence recorded before the breach is preserved");
  const terminal = result.events[result.events.length - 1];
  assert.equal((terminal.payload as { reason: string }).reason, "limit:max_steps");
});
