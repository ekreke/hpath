// The 1.0 analyze-agent: PRD -> case drafts (docs/overview/agent-design.md).
//
// Input: a PRD (md read directly, docx via mammoth, pdf via pdf-parse — see
// ./prd.ts) plus the project's existing case list. Output: one or more case
// drafts with status `pending` (creator {type: agent}, source_prd_ref set),
// shaped exactly like the proto Case message so the data layer can persist
// them as-is and they appear in ListCases awaiting human review.
//
// The drafts become full proto-shaped cases kernel-side: the agent proposes
// (title, goal, alignments, sourcePrdRef) through the schema-validated
// `write_case_draft` tool, which stamps id/project/status/creator/version/
// changelog/timestamps. A run succeeds only by submitting the stamped drafts
// through the kernel's structured verdict channel (finish_verdict).

import { CaseStatus, CreatorType } from "@hpath/contract";
import type { AgentDefinition, HardLimits, JsonSchemaValue } from "./types.js";

export const ANALYZE_AGENT_ID = "analyze-agent";

/** Default model id for the analyze-agent (OpenAI via pi-ai catalog). */
export const ANALYZE_AGENT_DEFAULT_MODEL = "gpt-4.1-mini";

export const ANALYZE_AGENT_DEFAULT_LIMITS: HardLimits = {
  maxSteps: 16,
  tokenBudget: 200_000,
  timeoutMs: 120_000,
};

/**
 * One three-way alignment declaration of a draft case (proto Alignment:
 * api_path / ui_anchor / rule, camelCase ts-proto naming).
 */
export const DRAFT_ALIGNMENT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["rule"],
  properties: {
    apiPath: { type: "string", description: "Relative API path or gRPC method, resolved against the env" },
    uiAnchor: { type: "string", description: "UI element the executor agent must observe" },
    rule: { type: "string", minLength: 1, description: "Alignment rule in plain language (PRD logic)" },
  },
  additionalProperties: false,
};

/**
 * What the agent proposes per draft through `write_case_draft`. Kernel-side
 * stamping (status/creator/version/...) is deliberately outside the agent's
 * control.
 */
export const DRAFT_INPUT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["title", "goal", "alignments", "sourcePrdRef"],
  properties: {
    title: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    alignments: { type: "array", minItems: 1, items: DRAFT_ALIGNMENT_SCHEMA },
    sourcePrdRef: { type: "string", minLength: 1, description: "PRD section reference, e.g. \"orders.md#transfer\"" },
  },
  additionalProperties: false,
};

/**
 * A stamped draft — exactly the proto Case shape (camelCase), ready for the
 * data layer: pending status, agent creator with the producing analyze run,
 * PRD traceability, initial version + changelog. This is the schema the
 * verdict channel enforces, so every schema-valid verdict carries drafts that
 * appear in ListCases awaiting review.
 */
export const CASE_DRAFT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: [
    "id", "projectId", "title", "goal", "alignments", "creator",
    "status", "sourcePrdRef", "version", "changelog", "createdAt", "updatedAt",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    alignments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["apiPath", "uiAnchor", "rule"],
        properties: {
          apiPath: { type: "string" },
          uiAnchor: { type: "string" },
          rule: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    creator: {
      type: "object",
      required: ["type", "name", "runRef"],
      properties: {
        type: { enum: [CreatorType.CREATOR_TYPE_AGENT] },
        name: { type: "string", minLength: 1 },
        runRef: { type: "string", minLength: 1, description: "\"analyze-run#<runId>\"" },
      },
      additionalProperties: false,
    },
    status: { enum: [CaseStatus.CASE_STATUS_PENDING] },
    sourcePrdRef: { type: "string", minLength: 1 },
    version: { type: "integer", minimum: 1 },
    changelog: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["version", "author", "comment", "changedAt"],
        properties: {
          version: { type: "integer", minimum: 1 },
          author: { type: "string", minLength: 1 },
          comment: { type: "string", minLength: 1 },
          changedAt: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

/** Run input: the PRD (base64 bytes + format) and the existing case list. */
export const ANALYZE_AGENT_INPUT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["projectId", "filename", "format", "contentBase64"],
  properties: {
    projectId: { type: "string", minLength: 1 },
    filename: { type: "string", minLength: 1 },
    format: { enum: ["md", "docx", "pdf"] },
    contentBase64: { type: "string", minLength: 1, description: "PRD file bytes, base64-encoded" },
    existingCases: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "goal"],
        properties: {
          title: { type: "string" },
          goal: { type: "string" },
        },
        additionalProperties: false,
      },
      description: "Cases already in the project; the agent must not duplicate them",
    },
  },
  additionalProperties: false,
};

/** Verdict: the analysis summary plus the full stamped drafts. */
export const ANALYZE_AGENT_OUTPUT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["summary", "drafts"],
  properties: {
    summary: { type: "string", minLength: 1, description: "One-paragraph analysis outcome" },
    drafts: {
      type: "array",
      minItems: 1,
      items: CASE_DRAFT_SCHEMA,
      description: "The stamped case drafts recorded via write_case_draft in this run",
    },
  },
  additionalProperties: false,
};

const SYSTEM_PROMPT_TEMPLATE = `You are the HPath analyze-agent. You read a product requirements document and turn it into reviewable test-case drafts.

PRD under analysis: "{{input.filename}}" (format: {{input.format}}), project "{{input.projectId}}".
Cases already in the project (do not duplicate them): {{input.existingCases}}

Procedure:
1. Call read_prd once to get the extracted plain text of the PRD.
2. Call list_existing_cases to see what coverage already exists.
3. Identify the independently verifiable behaviors in the PRD. For each one not already covered, call write_case_draft with:
   - title: short imperative case name,
   - goal: what the case verifies, in one sentence,
   - alignments: one entry per three-way alignment the case will verify; each carries rule (the PRD logic in plain language) and, where the PRD names them, apiPath (HTTP endpoint or gRPC method) and uiAnchor (the UI element to observe),
   - sourcePrdRef: "<filename>#<section anchor>" pointing at the PRD section the case came from.
4. Finish EXACTLY ONCE with finish_verdict: a one-paragraph summary plus the SAME drafts you recorded (the full stamped draft objects returned by write_case_draft).

Rules:
- Never invent PRD content. Every draft must trace to a PRD section through sourcePrdRef.
- Drafts must be verifiable: prefer behaviors with an observable UI side, a backend side and a clear rule.
- Status, creator, id, version and timestamps are stamped by the kernel — never include them in write_case_draft arguments.
- Stop after finish_verdict.`;

export interface AnalyzeAgentOptions {
  /** Model id override (default ANALYZE_AGENT_DEFAULT_MODEL). */
  model?: string;
  /** Hard limit overrides (defaults ANALYZE_AGENT_DEFAULT_LIMITS). */
  hardLimits?: Partial<HardLimits>;
}

/** Build the 1.0 analyze-agent definition. Register it on an AgentRegistry. */
export function createAnalyzeAgentDefinition(options: AnalyzeAgentOptions = {}): AgentDefinition {
  return {
    id: ANALYZE_AGENT_ID,
    role: "PRD analyst producing pending case drafts",
    systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
    toolBindings: ["prd-analysis"],
    model: options.model ?? ANALYZE_AGENT_DEFAULT_MODEL,
    hardLimits: { ...ANALYZE_AGENT_DEFAULT_LIMITS, ...options.hardLimits },
    inputSchema: ANALYZE_AGENT_INPUT_SCHEMA,
    outputSchema: ANALYZE_AGENT_OUTPUT_SCHEMA,
  };
}
