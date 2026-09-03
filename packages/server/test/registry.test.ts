// Unit tests: AgentRegistry (registered definitions, never hardcoded) and
// ToolProviderRegistry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/agents/registry.js";
import { ToolProviderRegistry } from "../src/agents/tools.js";
import type { ToolProvider } from "../src/agents/tools.js";
import { stubDefinition } from "./helpers/stub-model.js";

test("AgentRegistry registers, resolves, and lists definitions", () => {
  const registry = new AgentRegistry();
  const first = stubDefinition({ id: "agent-a" });
  const second = stubDefinition({ id: "agent-b" });
  registry.register(first).register(second);

  assert.ok(registry.has("agent-a"));
  assert.equal(registry.get("agent-a"), first);
  assert.equal(registry.require("agent-b"), second);
  assert.deepEqual(registry.list().map((definition) => definition.id), ["agent-a", "agent-b"]);
  assert.throws(() => registry.require("nope"), /no agent definition registered/);
});

test("AgentRegistry rejects duplicate ids", () => {
  const registry = new AgentRegistry().register(stubDefinition({ id: "dup" }));
  assert.throws(() => registry.register(stubDefinition({ id: "dup" })), /already registered/);
});

test("AgentRegistry validates definition shape at registration", () => {
  const registry = new AgentRegistry();
  assert.throws(
    () => registry.register(stubDefinition({ id: "" })),
    /field "id" must be a non-empty string/,
  );
  assert.throws(
    () =>
      registry.register(
        stubDefinition({ hardLimits: { maxSteps: 0, tokenBudget: 1, timeoutMs: 1 } }),
      ),
    /hardLimits\.maxSteps must be a positive number/,
  );
  assert.throws(
    () =>
      registry.register(
        stubDefinition({ hardLimits: { maxSteps: 1, tokenBudget: -5, timeoutMs: 1 } }),
      ),
    /hardLimits\.tokenBudget must be a positive number/,
  );
  assert.throws(
    () => registry.register(stubDefinition({ model: "" })),
    /field "model" must be a non-empty string/,
  );
  assert.throws(
    () => registry.register(stubDefinition({ toolBindings: "browser" as unknown as string[] })),
    /toolBindings must be an array/,
  );
});

const dummyProvider: ToolProvider = {
  id: "dummy",
  description: "dummy",
  createTools: () => [],
};

test("ToolProviderRegistry registers, resolves, and rejects duplicates", () => {
  const registry = new ToolProviderRegistry();
  registry.register(dummyProvider);

  assert.ok(registry.has("dummy"));
  assert.equal(registry.require("dummy"), dummyProvider);
  assert.equal(registry.get("nope"), undefined);
  assert.throws(() => registry.require("nope"), /no tool provider registered/);
  assert.throws(() => registry.register(dummyProvider), /already registered/);
  assert.throws(
    () => registry.register({ ...dummyProvider, id: "  " }),
    /non-empty string/,
  );
  assert.deepEqual(registry.list(), [dummyProvider]);
});
