// Per-run overrides from Settings: the pipeline prefers the per-agent model
// override over the definition default, appends the per-agent prompt to the
// rendered system prompt, and reports the effective model on the result.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { RunStatus } from "@hpath/contract";
import {
  AgentKernel,
  AgentRegistry,
  ToolProviderRegistry,
  type EnvBinding,
} from "../src/agents/index.js";
import {
  STUB_ENV,
  STUB_MODEL,
  VALID_VERDICT,
  assistantToolCallMessage,
  scriptedStreamFn,
  stubDefinition,
  type StreamCallRecord,
} from "./helpers/stub-model.js";

function makeKernel(streamFn: StreamFn, seenModels: string[]): AgentKernel {
  const agents = new AgentRegistry();
  const toolProviders = new ToolProviderRegistry();
  agents.register(stubDefinition());
  return new AgentKernel({
    agents,
    toolProviders,
    streamFn,
    resolveModel: (modelId) => {
      seenModels.push(modelId);
      return STUB_MODEL;
    },
  });
}

const ENV: EnvBinding = STUB_ENV;

test("modelOverride and promptOverride flow into the run", async () => {
  const calls: StreamCallRecord[] = [];
  const seenModels: string[] = [];
  const kernel = makeKernel(
    scriptedStreamFn(() => assistantToolCallMessage("finish_verdict", VALID_VERDICT), calls),
    seenModels,
  );

  const result = await kernel.run({
    agentId: "stub-agent",
    input: { goal: "check balance" },
    env: ENV,
    modelOverride: "custom-model",
    promptOverride: "PROJECT RULE: always report in CNY",
  });

  assert.equal(result.status, RunStatus.RUN_STATUS_PASSED, `failReason=${result.failReason}`);
  assert.equal(result.model, "custom-model");
  assert.ok(seenModels.includes("custom-model"));
  assert.ok(calls[0].systemPrompt.includes("PROJECT RULE: always report in CNY"));
  // The built-in role prompt is preserved alongside the appended block.
  assert.ok(calls[0].systemPrompt.includes("You test dev at"));
});

test("without overrides the definition default model is used and no prompt is appended", async () => {
  const calls: StreamCallRecord[] = [];
  const seenModels: string[] = [];
  const kernel = makeKernel(
    scriptedStreamFn(() => assistantToolCallMessage("finish_verdict", VALID_VERDICT), calls),
    seenModels,
  );

  const result = await kernel.run({
    agentId: "stub-agent",
    input: { goal: "check balance" },
    env: ENV,
  });

  assert.equal(result.model, STUB_MODEL.id);
  assert.deepEqual(seenModels, [STUB_MODEL.id]);
  assert.ok(!calls[0].systemPrompt.includes("Agent instructions (configured in Settings)"));
});
