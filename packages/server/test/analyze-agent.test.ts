// T9 tests: the analyze-agent (a registered AgentDefinition) ingests PRDs in
// all three formats (md read directly, docx via mammoth, pdf via pdf-parse)
// and produces schema-valid pending case drafts (creator {type: agent},
// source_prd_ref set) shaped exactly like the proto Case message, so they
// appear in ListCases awaiting review.
//
// OPENAI_API_KEY is unset in this environment, so the model is a *scripted*
// StreamFn (like T7b): it reads each tool result from the message context and
// derives the drafts from the REAL ingest results. The tool surface (read_prd
// with the real md/docx/pdf parsers, list_existing_cases, kernel-stamped
// write_case_draft) is fully exercised. Real-LLM verification stays pending
// manual verification (see .lane-status/agents.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Context,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  CaseStatus,
  RunStatus,
  CreatorType,
  type Case,
} from "@hpath/contract";
import {
  AgentKernel,
  AgentRegistry,
  ANALYZE_AGENT_DEFAULT_LIMITS,
  ANALYZE_AGENT_DEFAULT_MODEL,
  ANALYZE_AGENT_ID,
  ANALYZE_AGENT_INPUT_SCHEMA,
  ANALYZE_AGENT_OUTPUT_SCHEMA,
  CASE_DRAFT_SCHEMA,
  DRAFT_INPUT_SCHEMA,
  InMemoryEventSink,
  PrdIngestError,
  RunEvidence,
  ToolProviderRegistry,
  VerdictChannel,
  assertSchema,
  ingestPrd,
  prdFormatFromFilename,
  registerBuiltIns,
  validateSchema,
  type EnvBinding,
  type HardLimits,
  type ToolContext,
} from "../src/agents/index.js";
import { createWriteCaseDraftTool } from "../src/agents/providers/prd-analysis.js";
import {
  STUB_MODEL,
  assistantToolCallMessage,
  scriptedStreamFn,
  type StreamCallRecord,
} from "./helpers/stub-model.js";

// ── fixtures: the same PRD in all three formats ─────────────────────────────

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/prds/", import.meta.url));
const FIXTURE_FILES = ["orders.md", "orders.docx", "orders.pdf"] as const;
const EXISTING_CASES = [
  {
    title: "Order list matches the order service",
    goal: "Orders rendered in the UI are identical to the orders returned by the backend service.",
  },
];

// ── PRD ingest: all three formats + error paths ─────────────────────────────

test("prdFormatFromFilename maps supported extensions", () => {
  assert.equal(prdFormatFromFilename("orders.md"), "md");
  assert.equal(prdFormatFromFilename("ORDERS.Markdown"), "md");
  assert.equal(prdFormatFromFilename("orders.docx"), "docx");
  assert.equal(prdFormatFromFilename("orders.pdf"), "pdf");
  assert.equal(prdFormatFromFilename("orders.txt"), undefined);
  assert.equal(prdFormatFromFilename("orders"), undefined);
});

test("ingest extracts the sectioned PRD text from all three formats", async () => {
  for (const filename of FIXTURE_FILES) {
    const format = prdFormatFromFilename(filename);
    assert.ok(format, `format detected for ${filename}`);
    const ingested = await ingestPrd(readFileSync(FIXTURE_DIR + filename), format);
    assert.equal(ingested.format, format);
    assert.ok(ingested.chars > 400, `${filename}: substantial text extracted`);
    assert.ok(ingested.text.includes("Orders and Payments PRD"), `${filename}: title present`);
    assert.ok(ingested.text.includes("Section: Order list [anchor:order-list]"), `${filename}: sections survive ingest`);
    assert.ok(/GET \/api\/orders/.test(ingested.text), `${filename}: API paths survive ingest`);
    assert.ok(/GET \/api\/balance/.test(ingested.text), `${filename}: balance path survives ingest`);
  }
});

test("ingest failures are structured PrdIngestErrors naming the format", async () => {
  await assert.rejects(
    () => ingestPrd(Buffer.from("this is not a pdf"), "pdf"),
    (err: unknown) => err instanceof PrdIngestError && err.format === "pdf",
  );
  await assert.rejects(
    () => ingestPrd(Buffer.from("this is not a zip"), "docx"),
    (err: unknown) => err instanceof PrdIngestError && err.format === "docx",
  );
});

test("ingest rejects documents over the upload cap before parsing (zip-bomb guard)", async () => {
  // A high-compression docx/pdf could otherwise amplify a small upload into a
  // large parse; the byte gate must reject BEFORE any decompression.
  const oversized = Buffer.alloc(21 * 1024 * 1024, "a");
  await assert.rejects(
    () => ingestPrd(oversized, "docx"),
    (err: unknown) => err instanceof PrdIngestError && /upload cap/.test((err as Error).message),
  );
  await assert.rejects(
    () => ingestPrd(oversized, "pdf"),
    (err: unknown) => err instanceof PrdIngestError && /upload cap/.test((err as Error).message),
  );
  // The schema-level guard matches: a base64 payload above the cap is invalid input.
  const schema = ANALYZE_AGENT_INPUT_SCHEMA;
  const ok = validateSchema(
    { projectId: "p", filename: "x.md", format: "md", contentBase64: Buffer.from("small").toString("base64") },
    schema,
  );
  assert.equal(ok.length, 0);
  const tooBig = validateSchema(
    { projectId: "p", filename: "x.md", format: "md", contentBase64: "A".repeat(30 * 1024 * 1024) },
    schema,
  );
  assert.ok(tooBig.some((issue) => issue.path === "contentBase64"), "schema rejects oversized base64");
});

// ── definition + schemas ────────────────────────────────────────────────────

test("analyze-agent is a registered AgentDefinition with the T9 tool surface", () => {
  const agents = new AgentRegistry();
  const toolProviders = new ToolProviderRegistry();
  registerBuiltIns(agents, toolProviders);

  const definition = agents.require(ANALYZE_AGENT_ID);
  assert.equal(definition.id, "analyze-agent");
  assert.deepEqual(definition.toolBindings, ["prd-analysis"]);
  assert.equal(definition.model, ANALYZE_AGENT_DEFAULT_MODEL);
  assert.deepEqual(definition.hardLimits, ANALYZE_AGENT_DEFAULT_LIMITS);
  assert.ok(toolProviders.require("prd-analysis"), "prd-analysis provider registered");
  // The system prompt is env/input-bound and must NOT render the whole input
  // (it carries the PRD bytes; those reach the agent through read_prd).
  assert.ok(definition.systemPromptTemplate.includes("{{input.filename}}"));
  assert.ok(definition.systemPromptTemplate.includes("{{input.format}}"));
  assert.ok(!definition.systemPromptTemplate.includes("{{input}}"));
});

test("run input schema accepts the ParsePRD shape and rejects broken inputs", () => {
  const valid = {
    projectId: "proj-demo",
    filename: "orders.md",
    format: "md",
    contentBase64: "b2theQ==",
    existingCases: [{ title: "t", goal: "g" }],
  };
  assert.deepEqual(validateSchema(valid, ANALYZE_AGENT_INPUT_SCHEMA), []);
  assert.ok(
    validateSchema({ ...valid, format: "txt" }, ANALYZE_AGENT_INPUT_SCHEMA).some((issue) =>
      issue.path === "format",
    ),
  );
  assert.ok(
    validateSchema({ filename: "orders.md", format: "md" }, ANALYZE_AGENT_INPUT_SCHEMA).some(
      (issue) => issue.message.includes("required"),
    ),
  );
});

/** A full stamped draft as write_case_draft produces it. */
function stampedDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    projectId: "proj-demo",
    title: "Order list verified end to end",
    goal: "Rendered order rows match GET /api/orders exactly.",
    alignments: [{ apiPath: "/api/orders", uiAnchor: "dashboard order table", rule: "Every rendered row matches one API record." }],
    creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "analyze-agent", runRef: "analyze-run#run-1" },
    status: CaseStatus.CASE_STATUS_PENDING,
    sourcePrdRef: "orders.md#order-list",
    version: 1,
    changelog: [{ version: 1, author: "analyze-agent", comment: "Drafted from PRD by analyze-agent", changedAt: "2026-09-03T00:00:00.000Z" }],
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

test("case draft schema accepts only full pending agent drafts (proto Case shape)", () => {
  assert.deepEqual(validateSchema(stampedDraft(), CASE_DRAFT_SCHEMA), []);
  assertSchema(stampedDraft(), CASE_DRAFT_SCHEMA, "stamped draft");

  const cases: [string, Record<string, unknown>][] = [
    ["missing sourcePrdRef", { sourcePrdRef: "" }],
    ["approved status", { status: CaseStatus.CASE_STATUS_APPROVED }],
    ["human creator", { creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "john", runRef: "" } }],
    ["creator missing runRef", { creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "analyze-agent" } }],
    ["empty alignments", { alignments: [] }],
    ["alignment without rule", { alignments: [{ apiPath: "/api/orders", uiAnchor: "table" }] }],
    ["version zero", { version: 0 }],
    ["no changelog", { changelog: [] }],
    ["extra key", { oops: true }],
  ];
  for (const [what, overrides] of cases) {
    const issues = validateSchema(stampedDraft(overrides), CASE_DRAFT_SCHEMA);
    assert.ok(issues.length > 0, `rejected: ${what}`);
  }
});

test("verdict schema requires at least one schema-valid draft plus a summary", () => {
  const valid = { summary: "three behaviors drafted", drafts: [stampedDraft()] };
  assert.deepEqual(validateSchema(valid, ANALYZE_AGENT_OUTPUT_SCHEMA), []);

  const noDrafts = { summary: "nothing to draft", drafts: [] };
  assert.ok(validateSchema(noDrafts, ANALYZE_AGENT_OUTPUT_SCHEMA).some((issue) =>
    issue.message.includes("minItems 1"),
  ));

  const brokenDraft = { summary: "s", drafts: [{ title: "only a title" }] };
  assert.ok(validateSchema(brokenDraft, ANALYZE_AGENT_OUTPUT_SCHEMA).some((issue) =>
    issue.path.startsWith("drafts.0"),
  ));

  assert.ok(
    validateSchema({ title: "t", goal: "g", alignments: [], sourcePrdRef: "x" }, DRAFT_INPUT_SCHEMA)
      .some((issue) => issue.path === "alignments"),
  );
});

// ── write_case_draft stamping (direct provider test, no kernel/LLM) ─────────

function makeContext(runId: string, input: unknown): ToolContext {
  return {
    runId,
    agentId: ANALYZE_AGENT_ID,
    env: { projectId: "proj-demo", envId: "env-dev", name: "dev", baseUrl: "http://dev.example.test", variables: {} },
    input,
    events: new InMemoryEventSink({ runId }),
    verdict: new VerdictChannel({ type: "object" }),
    evidence: new RunEvidence(),
    signal: new AbortController().signal,
  };
}

interface ToolResultShape {
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
}

function asExecutable(tool: { execute: unknown }): (id: string, args: unknown) => Promise<ToolResultShape> {
  return tool.execute as (id: string, args: unknown) => Promise<ToolResultShape>;
}

test("write_case_draft stamps pending agent drafts kernel-side and records them as evidence", async () => {
  const runId = crypto.randomUUID();
  const context = makeContext(runId, { projectId: "proj-demo", filename: "orders.md", format: "md", contentBase64: "eA==" });
  const execute = asExecutable(createWriteCaseDraftTool(context));

  const result = await execute("call_1", {
    title: "Order cancellation verified end to end",
    goal: "A cancelled pending order reports status cancelled everywhere.",
    alignments: [{ rule: "POST /api/orders/cancel and the detail view agree on status cancelled." }],
    sourcePrdRef: "orders.md#cancel",
  });

  assert.equal(result.details?.recorded, true);
  const echoed = JSON.parse(result.content[0].text) as { total: number; draft: Case };
  assert.equal(echoed.total, 1);
  const draft = echoed.draft;

  // Kernel stamping: pending + agent creator referencing this analyze run.
  assert.equal(draft.status, CaseStatus.CASE_STATUS_PENDING);
  assert.deepEqual(draft.creator, {
    type: CreatorType.CREATOR_TYPE_AGENT,
    name: "analyze-agent",
    runRef: `analyze-run#${runId}`,
  });
  assert.equal(draft.version, 1);
  assert.equal(draft.projectId, "proj-demo");
  assert.equal(draft.sourcePrdRef, "orders.md#cancel");
  assert.ok(draft.id.length > 0);
  assert.equal(draft.changelog.length, 1);

  // Preserved as evidence even on later failure, and visible on the event pipe.
  assert.equal(context.evidence.entries.length, 1);
  const draftEvents = context.events.events().filter((event) => event.payload.kind === "case_draft_recorded");
  assert.equal(draftEvents.length, 1);

  // Invalid proposals are rejected before any stamping.
  await assert.rejects(() => execute("call_2", { title: "no goal" }), /case draft/);
  await assert.rejects(() => execute("call_2", {
    title: "t", goal: "g", alignments: [], sourcePrdRef: "orders.md#x",
  }), /minItems 1/);
  await assert.rejects(() => execute("call_2", {
    title: "t", goal: "g", alignments: [{ rule: "r" }], sourcePrdRef: "x", status: "approved",
  }), /additional property/);
});

// ── scripted model plumbing (reads real tool results from the context) ──────

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

interface PrdSection {
  title: string;
  anchor: string;
  rule: string;
  apiPath: string;
}

/** Parse the sectioned PRD text from the REAL read_prd result of this run. */
function prdSections(context: Context): PrdSection[] {
  const readPrd = toolResultTexts(context, "read_prd")[0];
  if (!readPrd) throw new Error("scripted model: no read_prd result");
  const text = (JSON.parse(readPrd) as { text: string }).text;
  const lines = text.split("\n");
  const sections: PrdSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^Section: (.+) \[anchor:([a-z0-9-]+)\]/.exec(lines[i]);
    if (!match) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("Section:"); j++) {
      if (lines[j].trim() !== "") body.push(lines[j].trim());
    }
    const firstSentence = body.join(" ").split(/(?<=\.)\s/)[0] ?? body.join(" ");
    const apiMatch = /(GET|POST) (\/api\/[A-Za-z0-9/-]+)/.exec(body.join(" "));
    sections.push({
      title: match[1],
      anchor: match[2],
      rule: firstSentence,
      apiPath: apiMatch ? apiMatch[2] : "/api/unknown",
    });
  }
  return sections;
}

/** Drafts the run recorded so far, as returned (stamped) by write_case_draft. */
function recordedDrafts(context: Context): Case[] {
  return toolResultTexts(context, "write_case_draft").map((text) => {
    return (JSON.parse(text) as { draft: Case }).draft;
  });
}

/**
 * The scripted analyze-agent procedure: read the PRD (real ingest), list the
 * existing cases, draft one case per PRD section derived from the REAL text,
 * then finish with the stamped drafts.
 */
const analyzeScript = (
  context: Context,
  call: number,
  runInput: { filename: string; projectId: string },
): AssistantMessage => {
  if (call === 1) return assistantToolCallMessage("read_prd", {});
  if (call === 2) return assistantToolCallMessage("list_existing_cases", {});
  const sections = prdSections(context);
  if (call >= 3 && call < 3 + sections.length) {
    const section = sections[call - 3];
    return assistantToolCallMessage("write_case_draft", {
      title: `${section.title} verified end to end`,
      goal: section.rule,
      alignments: [{ apiPath: section.apiPath, uiAnchor: "dashboard", rule: section.rule }],
      sourcePrdRef: `${runInput.filename}#${section.anchor}`,
    });
  }
  if (call === 3 + sections.length) {
    const drafts = recordedDrafts(context);
    if (drafts.length !== sections.length) {
      throw new Error("scripted model: expected one recorded draft per PRD section");
    }
    return assistantToolCallMessage("finish_verdict", {
      summary: `Drafted ${drafts.length} cases from the PRD; all are pending review.`,
      drafts,
    });
  }
  throw new Error(`scripted model: unexpected call ${call}`);
};

function makeAnalyzeKernel(streamFn: StreamFn, hardLimits: Partial<HardLimits> = {}): AgentKernel {
  const agents = new AgentRegistry();
  const toolProviders = new ToolProviderRegistry();
  registerBuiltIns(agents, toolProviders, { analyzeAgent: { hardLimits: { timeoutMs: 60_000, ...hardLimits } } });
  return new AgentKernel({ agents, toolProviders, streamFn, resolveModel: () => STUB_MODEL });
}

const ANALYZE_ENV: EnvBinding = {
  projectId: "proj-demo",
  envId: "env-demo-dev",
  name: "dev",
  baseUrl: "http://dev.example.test",
  variables: {},
};

function analyzeInput(filename: (typeof FIXTURE_FILES)[number]): {
  projectId: string;
  filename: string;
  format: "md" | "docx" | "pdf";
  contentBase64: string;
  existingCases: { title: string; goal: string }[];
} {
  const bytes = readFileSync(FIXTURE_DIR + filename);
  return {
    projectId: "proj-demo",
    filename,
    format: prdFormatFromFilename(filename) as "md" | "docx" | "pdf",
    contentBase64: bytes.toString("base64"),
    existingCases: EXISTING_CASES,
  };
}

// ── acceptance: all three PRD formats produce schema-valid pending drafts ───

for (const filename of FIXTURE_FILES) {
  test(`acceptance (${filename}): analyze-agent turns the PRD into schema-valid pending drafts visible in ListCases`, async () => {
    const calls: StreamCallRecord[] = [];
    const input = analyzeInput(filename);
    const kernel = makeAnalyzeKernel(
      scriptedStreamFn((context, call) => analyzeScript(context, call, input), calls),
    );
    const result = await kernel.run({
      agentId: ANALYZE_AGENT_ID,
      input,
      env: ANALYZE_ENV,
    });

    // The run passed through the structured verdict channel.
    assert.equal(result.status, RunStatus.RUN_STATUS_PASSED, `failReason=${result.failReason}`);
    assert.equal(result.failReason, "");

    // Env/input-bound injection: the prompt names the file and existing coverage,
    // and never carries the PRD bytes themselves.
    assert.ok(calls[0].systemPrompt.includes(`"${filename}"`));
    assert.ok(calls[0].systemPrompt.includes("proj-demo"));
    assert.ok(calls[0].systemPrompt.includes(EXISTING_CASES[0].title));
    assert.ok(!calls[0].systemPrompt.includes("contentBase64"));

    const drafts = (result.verdict?.drafts ?? []) as Case[];
    assert.equal(drafts.length, 3, "one draft per PRD section");

    for (const draft of drafts) {
      // Schema-valid: this is the same validation the verdict channel ran.
      assert.deepEqual(validateSchema(draft, CASE_DRAFT_SCHEMA), []);
      // Proto Case shape: assignable and consistent with the seeded cases.
      const kase: Case = draft;
      assert.equal(kase.status, CaseStatus.CASE_STATUS_PENDING, "drafts await review");
      assert.equal(kase.creator!.type, CreatorType.CREATOR_TYPE_AGENT);
      assert.equal(kase.creator!.name, "analyze-agent");
      assert.equal(kase.creator!.runRef, `analyze-run#${result.runId}`);
      assert.ok(kase.sourcePrdRef.startsWith(`${filename}#`), "PRD traceability set");
      assert.equal(kase.version, 1);
      assert.ok(kase.alignments.length >= 1 && kase.alignments[0].rule.length > 0);
    }

    // Sections -> drafts 1:1, each traceable to its anchor.
    const anchors = drafts.map((draft) => draft.sourcePrdRef.split("#")[1]);
    assert.deepEqual(anchors, ["order-list", "cancel", "balance"]);

    // Drafts are content-derived, not hardcoded: rules and API paths come from
    // the ingested PRD text of THIS run.
    assert.ok(drafts[0].goal.startsWith("The dashboard shows"));
    assert.equal(drafts[0].alignments[0].apiPath, "/api/orders");
    assert.equal(drafts[1].alignments[0].apiPath, "/api/orders/cancel");
    assert.ok(drafts[2].goal.includes("GET /api/balance"));

    // The drafts appear in ListCases awaiting review: filtering by pending
    // status for the project (the ListCases contract) returns all of them.
    const pendingForProject = drafts.filter(
      (draft) => draft.projectId === "proj-demo" && draft.status === CaseStatus.CASE_STATUS_PENDING,
    );
    assert.equal(pendingForProject.length, 3);

    // Every draft was recorded as evidence before the verdict.
    const draftEvents = result.events.filter((event) => event.payload.kind === "case_draft_recorded");
    assert.equal(draftEvents.length, 3);

    // Terminal event: run passed through the structured verdict channel.
    const terminal = result.events[result.events.length - 1];
    assert.equal(terminal.payload.kind, "run_status");
    assert.equal((terminal.payload as { status: RunStatus }).status, RunStatus.RUN_STATUS_PASSED);
  });
}

test("hard limits still apply to the analyze-agent: drafts recorded before a breach are preserved", async () => {
  const input = analyzeInput("orders.md");
  const kernel = makeAnalyzeKernel(
    scriptedStreamFn((context, call) => analyzeScript(context, call, input)),
    { maxSteps: 4 },
  );
  const result = await kernel.run({
    agentId: ANALYZE_AGENT_ID,
    input,
    env: ANALYZE_ENV,
  });

  assert.equal(result.failReason, "limit:max_steps");
  assert.equal(result.verdict, undefined);
  // The drafts recorded before the breach survive on the event pipe.
  const draftEvents = result.events.filter((event) => event.payload.kind === "case_draft_recorded");
  assert.ok(draftEvents.length >= 1, "drafts recorded before the breach are preserved");
  for (const event of draftEvents) {
    const draft = (event.payload as unknown as { draft: Case }).draft;
    assert.equal(draft.status, CaseStatus.CASE_STATUS_PENDING);
  }
});
