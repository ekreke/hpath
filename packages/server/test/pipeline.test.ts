// T7a acceptance: a stub AgentDefinition runs the whole shared pipeline end
// to end — fresh session, env-bound injection, event recording, hard limits,
// and the structured verdict channel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { RunStatus } from "@hpath/contract";
import { AgentKernel } from "../src/agents/pipeline.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { ToolProviderRegistry } from "../src/agents/tools.js";
import type { ToolProvider } from "../src/agents/tools.js";
import type { AgentRunEventPayload } from "../src/agents/types.js";
import {
  STUB_ENV,
  STUB_MODEL,
  VALID_VERDICT,
  assistantTextMessage,
  assistantToolCallMessage,
  hangingStreamFn,
  scriptedStreamFn,
  stubDefinition,
  type StreamCallRecord,
} from "./helpers/stub-model.js";

/** No-op sandbox provider so limit tests can loop on a real bound tool. */
function sandboxProvider(): ToolProvider {
  return {
    id: "sandbox",
    description: "no-op test tool",
    createTools: () => [
      {
        name: "noop",
        label: "No-op",
        description: "does nothing",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "noop done" }],
          details: {},
        }),
      },
    ],
  };
}

function makeKernel(
  streamFn: StreamFn,
  providers: ToolProvider[] = [],
  definitionOverrides: Parameters<typeof stubDefinition>[0] = {},
): AgentKernel {
  const agents = new AgentRegistry().register(stubDefinition(definitionOverrides));
  const toolProviders = new ToolProviderRegistry();
  for (const provider of providers) {
    toolProviders.register(provider);
  }
  return new AgentKernel({ agents, toolProviders, streamFn, resolveModel: () => STUB_MODEL });
}

function payloadKinds(events: { payload: AgentRunEventPayload }[]): string[] {
  return events.map((event) => event.payload.kind);
}

const BASE_INPUT = { goal: "login flow" };

test("stub definition runs the whole pipeline end to end and records a verdict", async () => {
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn(
    () => assistantToolCallMessage("finish_verdict", VALID_VERDICT),
    calls,
  );
  const kernel = makeKernel(streamFn);
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED);
  assert.equal(result.failReason, "");
  assert.deepEqual(result.verdict, VALID_VERDICT);
  assert.match(result.runId, /^[0-9a-f-]{36}$/);

  // Env-bound injection: the current env's values are in the system prompt.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].systemPrompt.includes("http://dev.example.test"));
  assert.ok(calls[0].systemPrompt.includes("login flow"));
  assert.ok(calls[0].systemPrompt.includes("dev-secret"));

  // Fresh session: the model saw exactly one message, the user prompt.
  assert.deepEqual(calls[0].roles, ["user"]);

  // Event recording: session boundaries, tool lifecycle, verdict, terminal.
  const kinds = payloadKinds(result.events);
  assert.equal(kinds[0], "run_status");
  const runStatuses = result.events.filter((event) => event.payload.kind === "run_status");
  assert.equal(runStatuses.length, 2);
  assert.deepEqual(
    runStatuses.map((event) => (event.payload as { status: RunStatus }).status),
    [RunStatus.RUN_STATUS_RUNNING, RunStatus.RUN_STATUS_PASSED],
  );
  assert.ok(kinds.includes("tool_started"));
  assert.ok(kinds.includes("tool_finished"));
  const verdictEvent = result.events.find((event) => event.payload.kind === "verdict");
  assert.ok(verdictEvent);
  assert.deepEqual((verdictEvent!.payload as { verdict: unknown }).verdict, VALID_VERDICT);
  assert.equal(kinds[kinds.length - 1], "run_status");

  // Sequencing is 1-based and dense.
  assert.deepEqual(
    result.events.map((event) => event.seq),
    result.events.map((_, index) => index + 1),
  );

  // Result duration is consistent with timestamps.
  assert.ok(result.durationMs >= 0);
  assert.ok(result.finishedAt >= result.startedAt);
});

test("every run is a fresh session with its own id and verdict channel", async () => {
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn(
    (_context, call) =>
      assistantToolCallMessage("finish_verdict", {
        status: "pass",
        summary: `run number ${call}`,
      }),
    calls,
  );
  const kernel = makeKernel(streamFn);
  const first = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });
  const second = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.notEqual(first.runId, second.runId);
  assert.equal(second.status, RunStatus.RUN_STATUS_PASSED);
  // No cross-run memory: the second call still saw only the fresh user prompt.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].roles, ["user"]);
  assert.deepEqual(second.verdict, { status: "pass", summary: "run number 2" });
});

test("input schema violations fail fast without contacting the model", async () => {
  const calls: StreamCallRecord[] = [];
  const kernel = makeKernel(scriptedStreamFn(() => assistantTextMessage("hi"), calls));
  const result = await kernel.run({ agentId: "stub-agent", input: { wrong: true }, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "input_schema");
  assert.equal(result.verdict, undefined);
  assert.equal(calls.length, 0);
  const errorEvent = result.events.find((event) => event.payload.kind === "error");
  assert.ok(errorEvent);
  assert.equal((errorEvent!.payload as { errorKind: string }).errorKind, "input_schema");
  const terminal = result.events[result.events.length - 1];
  assert.equal((terminal.payload as { status: RunStatus }).status, RunStatus.RUN_STATUS_FAILED);
});

test("unknown template variables abort the run before the model is called", async () => {
  const calls: StreamCallRecord[] = [];
  const agents = new AgentRegistry().register(
    stubDefinition({ systemPromptTemplate: "Target {{env.doesNotExist}}" }),
  );
  const kernel = new AgentKernel({
    agents,
    toolProviders: new ToolProviderRegistry(),
    streamFn: scriptedStreamFn(() => assistantTextMessage("hi"), calls),
    resolveModel: () => STUB_MODEL,
  });
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "template");
  assert.equal(calls.length, 0);
  const errorEvent = result.events.find((event) => event.payload.kind === "error");
  assert.ok(errorEvent);
  assert.ok((errorEvent!.payload as { message: string }).message.includes("env.doesNotExist"));
});

test("binding an unknown tool provider fails the run with a tool_provider error", async () => {
  const calls: StreamCallRecord[] = [];
  const agents = new AgentRegistry().register(stubDefinition({ toolBindings: ["missing"] }));
  const kernel = new AgentKernel({
    agents,
    toolProviders: new ToolProviderRegistry(),
    streamFn: scriptedStreamFn(() => assistantTextMessage("hi"), calls),
    resolveModel: () => STUB_MODEL,
  });
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "agent_error");
  assert.equal(calls.length, 0);
  const errorEvent = result.events.find((event) => event.payload.kind === "error");
  assert.equal((errorEvent!.payload as { errorKind: string }).errorKind, "tool_provider");
});

test("running an unregistered agent id is a caller error", async () => {
  const kernel = makeKernel(scriptedStreamFn(() => assistantTextMessage("hi")));
  await assert.rejects(
    () => kernel.run({ agentId: "nope", input: BASE_INPUT, env: STUB_ENV }),
    /no agent definition registered/,
  );
});

test("maxSteps limit: stop, preserve evidence, mark failed as limit:max_steps", async () => {
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn(() => assistantToolCallMessage("noop", {}), calls);
  const agents = new AgentRegistry().register(
    stubDefinition({
      toolBindings: ["sandbox"],
      hardLimits: { maxSteps: 2, tokenBudget: 100_000, timeoutMs: 5_000 },
    }),
  );
  const toolProviders = new ToolProviderRegistry().register(sandboxProvider());
  const kernel = new AgentKernel({
    agents,
    toolProviders,
    streamFn,
    resolveModel: () => STUB_MODEL,
  });
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "limit:max_steps");
  assert.equal(result.verdict, undefined);
  // The loop stopped after exactly maxSteps model calls.
  assert.equal(calls.length, 2);

  // Evidence from both steps is preserved.
  const toolStarted = result.events.filter(
    (event) => event.payload.kind === "tool_started" && (event.payload as { tool: string }).tool === "noop",
  );
  const toolFinished = result.events.filter((event) => event.payload.kind === "tool_finished");
  assert.equal(toolStarted.length, 2);
  assert.equal(toolFinished.length, 2);
  assert.ok(toolFinished.every((event) => (event.payload as { ok: boolean }).ok));

  const terminal = result.events[result.events.length - 1];
  assert.deepEqual(terminal.payload, {
    kind: "run_status",
    status: RunStatus.RUN_STATUS_FAILED,
    reason: "limit:max_steps",
  });
});

test("env agentLimits override the definition defaults per field", async () => {
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn(() => assistantToolCallMessage("noop", {}), calls);
  // Generous definition default; the env tightens only maxSteps.
  const agents = new AgentRegistry().register(
    stubDefinition({
      toolBindings: ["sandbox"],
      hardLimits: { maxSteps: 10, tokenBudget: 100_000, timeoutMs: 5_000 },
    }),
  );
  const toolProviders = new ToolProviderRegistry().register(sandboxProvider());
  const kernel = new AgentKernel({
    agents,
    toolProviders,
    streamFn,
    resolveModel: () => STUB_MODEL,
  });
  const result = await kernel.run({
    agentId: "stub-agent",
    input: BASE_INPUT,
    env: { ...STUB_ENV, agentLimits: { maxSteps: 2 } },
  });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "limit:max_steps");
  // The loop stopped after exactly the env-overridden step count.
  assert.equal(calls.length, 2);
});

test("env agentLimits with 0 values fall back to the definition defaults", async () => {
  const kernel = makeKernel(
    scriptedStreamFn(() => assistantToolCallMessage("finish_verdict", VALID_VERDICT)),
  );
  const result = await kernel.run({
    agentId: "stub-agent",
    input: BASE_INPUT,
    env: { ...STUB_ENV, agentLimits: { maxSteps: 0, tokenBudget: 0, timeoutMs: 0 } },
  });

  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED);
  assert.equal(result.failReason, "");
});

test("tokenBudget limit: cumulative usage is capped and reported", async () => {
  const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const agents = new AgentRegistry().register(
    stubDefinition({
      hardLimits: { maxSteps: 10, tokenBudget: 120, timeoutMs: 5_000 },
    }),
  );
  const kernel = new AgentKernel({
    agents,
    toolProviders: new ToolProviderRegistry(),
    streamFn: scriptedStreamFn(() => assistantTextMessage("thinking out loud", usage)),
    resolveModel: () => STUB_MODEL,
  });
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "limit:token_budget");
  assert.equal(result.tokenCost, 150);
  const textEvents = result.events.filter((event) => event.payload.kind === "agent_text");
  assert.equal(textEvents.length, 1);
});

test("timeoutMs limit: wall-clock breach stops the run as limit:timeout", async () => {
  const agents = new AgentRegistry().register(
    stubDefinition({
      hardLimits: { maxSteps: 10, tokenBudget: 100_000, timeoutMs: 80 },
    }),
  );
  const kernel = new AgentKernel({
    agents,
    toolProviders: new ToolProviderRegistry(),
    streamFn: hangingStreamFn(),
    resolveModel: () => STUB_MODEL,
  });
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "limit:timeout");
  assert.ok(result.durationMs < 5000, "run should stop at the timeout, not hang");
  const terminal = result.events[result.events.length - 1];
  assert.equal((terminal.payload as { reason: string }).reason, "limit:timeout");
});

test("a verdict violating the output schema is rejected; run fails with no_verdict", async () => {
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn((_context, call) =>
    call === 1
      ? assistantToolCallMessage("finish_verdict", { status: "excellent" })
      : assistantTextMessage("giving up"),
    calls,
  );
  const kernel = makeKernel(streamFn);
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "no_verdict");
  assert.equal(result.verdict, undefined);
  // The invalid submission was captured as a failed tool call.
  const finished = result.events.filter((event) => event.payload.kind === "tool_finished");
  assert.equal(finished.length, 1);
  assert.equal((finished[0].payload as { ok: boolean }).ok, false);
});

test("a run that ends without a verdict always fails with no_verdict", async () => {
  const kernel = makeKernel(scriptedStreamFn(() => assistantTextMessage("all done, bye")));
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "no_verdict");
  assert.equal(result.verdict, undefined);
  // Agent text is still recorded as evidence.
  const textEvents = result.events.filter((event) => event.payload.kind === "agent_text");
  assert.equal(textEvents.length, 1);
  assert.equal((textEvents[0].payload as { text: string }).text, "all done, bye");
});

// ── review fixes: event symmetry and hard-limit abort propagation ───────────

/** Tool that only resolves when the run abort signal fires (in-flight hang). */
function hangingProvider(): ToolProvider {
  return {
    id: "hang",
    description: "blocks until the run abort signal fires",
    createTools: () => [
      {
        name: "hang",
        label: "Hang",
        description: "does nothing except wait for the abort signal",
        parameters: Type.Object({}),
        execute: (_id, _args, signal) => new Promise((resolve) => {
          const finish = (): void => {
            resolve({ content: [{ type: "text", text: "aborted" }], details: {} });
          };
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        }),
      },
    ],
  };
}

test("every tool_started is paired with a tool_finished, even on argument validation failure", async () => {
  const pickyProvider: ToolProvider = {
    id: "picky",
    description: "tool whose schema rejects malformed args",
    createTools: () => [
      {
        name: "picky_tool",
        label: "Picky",
        description: "requires a number",
        parameters: Type.Object({ count: Type.Number() }),
        execute: async () => ({ content: [{ type: "text", text: "never reached" }], details: {} }),
      },
    ],
  };
  const agents = new AgentRegistry().register(stubDefinition({
    toolBindings: ["picky"],
    hardLimits: { maxSteps: 10, tokenBudget: 100_000, timeoutMs: 5_000 },
  }));
  const toolProviders = new ToolProviderRegistry().register(pickyProvider);
  const streamFn = scriptedStreamFn((_context, call) => {
    // Call 1: an invalid-argument tool call (schema rejects "count": "nope").
    // Call 2: the valid verdict.
    return call === 1
      ? assistantToolCallMessage("picky_tool", { count: "nope" })
      : assistantToolCallMessage("finish_verdict", VALID_VERDICT);
  });
  const kernel = new AgentKernel({ agents, toolProviders, streamFn, resolveModel: () => STUB_MODEL });
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });

  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED);
  const started = result.events.filter((event) => event.payload.kind === "tool_started" && (event.payload as { tool: string }).tool === "picky_tool");
  const finished = result.events.filter((event) => event.payload.kind === "tool_finished" && (event.payload as { tool: string }).tool === "picky_tool");
  assert.equal(started.length, 1, "invalid call still records tool_started");
  assert.equal(finished.length, 1, "invalid call must also record tool_finished (no dangling start)");
  assert.equal((finished[0].payload as { ok: boolean }).ok, false);
  // Ordering: the finish follows the start.
  assert.ok(started[0].seq < finished[0].seq);
});

test("a hanging tool call cannot outlive the wall-clock hard limit", async () => {
  const agents = new AgentRegistry().register(stubDefinition({
    toolBindings: ["hang"],
    hardLimits: { maxSteps: 10, tokenBudget: 100_000, timeoutMs: 250 },
  }));
  const toolProviders = new ToolProviderRegistry().register(hangingProvider());
  const kernel = new AgentKernel({
    agents,
    toolProviders,
    streamFn: scriptedStreamFn(() => assistantToolCallMessage("hang", {})),
    resolveModel: () => STUB_MODEL,
  });

  const startedAt = Date.now();
  const result = await kernel.run({ agentId: "stub-agent", input: BASE_INPUT, env: STUB_ENV });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, RunStatus.RUN_STATUS_FAILED);
  assert.equal(result.failReason, "limit:timeout");
  assert.ok(elapsed < 5_000, "run must finish shortly after the limit trips, not hang forever");
  // The aborted tool's completion is still recorded (event symmetry).
  const finished = result.events.filter((event) =>
    event.payload.kind === "tool_finished" && (event.payload as { tool: string }).tool === "hang",
  );
  assert.ok(finished.length >= 1, "the aborted hanging tool still emits tool_finished");
});

// ── run control: PauseRun / ResumeRun / CancelRun through the kernel registry ─

/** Poll until `predicate` holds or the budget expires (pause-gate timing). */
async function waitForCondition(predicate: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitForCondition: predicate never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Provider whose tool blocks until the test releases it. Gives the test a
 * deterministic handle on "the first turn ended, tool executed": the pause
 * gate sits at the turn boundary, so pausing while this tool is pending
 * suspends the loop before the second model call.
 */
function blockingToolProvider(): { provider: ToolProvider; release: () => void; entered: Promise<void> } {
  let releaseGate: () => void = () => {};
  const release = () => releaseGate();
  let enterGate: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enterGate = resolve;
  });
  const provider: ToolProvider = {
    id: "block",
    description: "blocks until released by the test",
    createTools: () => [
      {
        name: "block",
        label: "Block",
        description: "waits for the test to release it",
        parameters: Type.Object({}),
        execute: async (_id, _args, signal) =>
          new Promise((resolve) => {
            enterGate?.();
            const finish = () =>
              resolve({ content: [{ type: "text", text: "released" }], details: {} });
            if (signal?.aborted) finish();
            else signal?.addEventListener("abort", finish, { once: true });
            releaseGate = () => {
              signal?.removeEventListener("abort", finish);
              finish();
            };
          }),
      },
    ],
  };
  return { provider, release, entered };
}

test("pause at a turn boundary suspends the loop; resume completes the run", async () => {
  const { provider, release, entered } = blockingToolProvider();
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn((_context, call) =>
    call === 1
      ? assistantToolCallMessage("block", {})
      : assistantToolCallMessage("finish_verdict", VALID_VERDICT),
    calls,
  );
  const kernel = makeKernel(streamFn, [provider], { toolBindings: ["block"] });

  const runId = "pause-resume-run";
  const runPromise = kernel.run({ agentId: "stub-agent", runId, input: BASE_INPUT, env: STUB_ENV });

  // The first turn's tool is executing: the turn boundary (and the pause
  // gate) sits right behind it. Pause while the loop is still inside the
  // first turn — the gate arms for the upcoming boundary.
  await entered;
  kernel.runControl.get(runId)!.pause();
  release();

  // The loop is suspended at the turn boundary: the second model call never
  // arrives while paused.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(calls.length, 1, "the paused loop must not advance to the next model call");

  kernel.runControl.get(runId)!.resume();
  const result = await runPromise;

  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED);
  assert.equal(calls.length, 2);
  const statuses = result.events
    .filter((event) => event.payload.kind === "run_status")
    .map((event) => (event.payload as { status: RunStatus }).status);
  assert.ok(statuses.includes(RunStatus.RUN_STATUS_PAUSED), "PAUSED is recorded");
  assert.ok(
    statuses.indexOf(RunStatus.RUN_STATUS_PAUSED) < statuses.indexOf(RunStatus.RUN_STATUS_PASSED),
  );
  // Pause is unregistered after settle.
  assert.equal(kernel.runControl.get(runId), undefined);
});

test("cancel while paused unwinds the gate and settles as CANCELLED", async () => {
  const { provider, release, entered } = blockingToolProvider();
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn(() => assistantToolCallMessage("block", {}), calls);
  const kernel = makeKernel(streamFn, [provider], { toolBindings: ["block"] });

  const runId = "cancel-while-paused-run";
  const runPromise = kernel.run({ agentId: "stub-agent", runId, input: BASE_INPUT, env: STUB_ENV });

  await entered;
  kernel.runControl.get(runId)!.pause();
  kernel.runControl.get(runId)!.cancel();
  release();
  const result = await runPromise;

  assert.equal(result.status, RunStatus.RUN_STATUS_CANCELLED);
  assert.equal(result.failReason, "cancelled");
  assert.equal(result.verdict, undefined);
  const terminal = result.events[result.events.length - 1];
  assert.deepEqual(terminal.payload, {
    kind: "run_status",
    status: RunStatus.RUN_STATUS_CANCELLED,
    reason: "cancelled",
  });
  assert.equal(kernel.runControl.get(runId), undefined);
});

test("cancel during an in-flight tool aborts it and settles as CANCELLED", async () => {
  const kernel = new AgentKernel({
    agents: new AgentRegistry().register(stubDefinition({
      toolBindings: ["hang"],
      hardLimits: { maxSteps: 10, tokenBudget: 100_000, timeoutMs: 5_000 },
    })),
    toolProviders: new ToolProviderRegistry().register(hangingProvider()),
    streamFn: scriptedStreamFn(() => assistantToolCallMessage("hang", {})),
    resolveModel: () => STUB_MODEL,
  });

  const runId = "cancel-in-flight-run";
  const runPromise = kernel.run({ agentId: "stub-agent", runId, input: BASE_INPUT, env: STUB_ENV });

  await waitForCondition(() => kernel.runControl.get(runId) !== undefined);
  kernel.runControl.get(runId)!.cancel();
  const result = await runPromise;

  assert.equal(result.status, RunStatus.RUN_STATUS_CANCELLED);
  assert.equal(result.failReason, "cancelled");
});

test("pause stops the wall-clock timer; the suspended time is not charged", async () => {
  const { provider, release, entered } = blockingToolProvider();
  const calls: StreamCallRecord[] = [];
  const streamFn = scriptedStreamFn((_context, call) =>
    call === 1
      ? assistantToolCallMessage("block", {})
      : assistantToolCallMessage("finish_verdict", VALID_VERDICT),
    calls,
  );
  const kernel = makeKernel(streamFn, [provider], { toolBindings: ["block"] });

  const runId = "pause-timer-run";
  const runPromise = kernel.run({ agentId: "stub-agent", runId, input: BASE_INPUT, env: STUB_ENV });

  await entered;
  kernel.runControl.get(runId)!.pause();
  // Stay suspended longer than the whole wall-clock budget would allow
  // (timeoutMs is 5s); the timer must be stopped while paused.
  await new Promise((resolve) => setTimeout(resolve, 600));
  kernel.runControl.get(runId)!.resume();
  release();
  const result = await runPromise;

  // The 5s timer was stopped while paused: the run still passes, and the
  // reported duration excludes the suspended span.
  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED);
  assert.ok(result.durationMs < 5_000, "paused span must not be charged to the duration");
});

test("invalid control transitions throw InvalidTransitionError", async () => {
  const kernel = makeKernel(scriptedStreamFn(() => assistantTextMessage("bye")));
  const runPromise = kernel.run({ agentId: "stub-agent", runId: "bad-transitions", input: BASE_INPUT, env: STUB_ENV });

  const controller = kernel.runControl.get("bad-transitions")!;
  assert.throws(() => controller.resume(), /cannot resume/);
  await runPromise;
  // The run is settled: the controller is unregistered (further control is
  // FAILED_PRECONDITION at the RPC layer, not this registry).
  assert.equal(kernel.runControl.get("bad-transitions"), undefined);
});
