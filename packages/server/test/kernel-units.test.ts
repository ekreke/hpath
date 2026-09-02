// Unit tests: schema subset validator, prompt template rendering, and the
// structured verdict channel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSchema, schemaMatches, validateSchema } from "../src/agents/schema.js";
import { renderTemplate } from "../src/agents/template.js";
import { VerdictChannel } from "../src/agents/verdict.js";

const OBJECT_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    count: { type: "integer", minimum: 1 },
    tags: { type: "array", items: { type: "string" } },
    kind: { enum: ["a", "b"] },
  },
  additionalProperties: false,
};

test("schema validator accepts valid values", () => {
  assert.deepEqual(
    validateSchema(
      { name: "case", count: 2, tags: ["x"], kind: "a" },
      OBJECT_SCHEMA,
    ),
    [],
  );
  assert.equal(schemaMatches({ name: "case" }, OBJECT_SCHEMA), true);
  assert.equal(schemaMatches(null, { type: ["null", "string"] }), true);
  assert.equal(schemaMatches(3, { type: "number" }), true);
});

test("schema validator reports violations with paths", () => {
  const issues = validateSchema(
    { name: 42, count: 0, tags: ["ok", 7], kind: "zzz", extra: 1 },
    OBJECT_SCHEMA,
  );
  const messages = issues.map((issue) => `${issue.path}: ${issue.message}`);
  assert.ok(messages.some((message) => message.startsWith("name:")));
  assert.ok(messages.some((message) => message.startsWith("count:")));
  assert.ok(messages.some((message) => message.startsWith("tags.1:")));
  assert.ok(messages.some((message) => message.startsWith("kind:")));
  assert.ok(messages.some((message) => message.startsWith("extra:")));
  // Missing required property.
  const missing = validateSchema({}, OBJECT_SCHEMA);
  assert.ok(missing.some((issue) => issue.message.includes("name")));
});

test("assertSchema throws a descriptive error", () => {
  assert.throws(() => assertSchema({}, OBJECT_SCHEMA, "run input"), /run input/);
});

test("template rendering resolves env and input paths", () => {
  const rendered = renderTemplate("Env {{env.name}} at {{env.baseUrl}}; goal: {{input.goal}}; vars: {{env.variables}}", {
    env: { name: "dev", baseUrl: "http://d", variables: { a: 1 } },
    input: { goal: "log in" },
  });
  assert.equal(rendered, 'Env dev at http://d; goal: log in; vars: {"a":1}');
});

test("template rendering is strict about unknown variables", () => {
  assert.throws(
    () => renderTemplate("Hello {{env.stagingUrl}}", { env: { name: "dev" }, input: {} }),
    /unknown template variable "env\.stagingUrl"/,
  );
});

const VERDICT_SCHEMA = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { enum: ["pass", "fail"] },
    summary: { type: "string" },
  },
};

test("verdict channel records only schema-valid verdicts, exactly once", () => {
  const channel = new VerdictChannel(VERDICT_SCHEMA);
  assert.equal(channel.isRecorded, false);

  const verdict = channel.record({ status: "pass", summary: "ok" });
  assert.deepEqual(verdict, { status: "pass", summary: "ok" });
  assert.equal(channel.isRecorded, true);
  assert.deepEqual(channel.value, { status: "pass", summary: "ok" });

  assert.throws(
    () => channel.record({ status: "fail", summary: "second" }),
    /verdict already recorded/,
  );
});

test("verdict channel rejects schema-invalid verdicts", () => {
  const channel = new VerdictChannel(VERDICT_SCHEMA);
  assert.throws(() => channel.record({ status: "pass" }), /verdict/);
  assert.throws(() => channel.record({ status: "excellent", summary: "x" }), /not in enum/);
  assert.equal(channel.isRecorded, false);
});
