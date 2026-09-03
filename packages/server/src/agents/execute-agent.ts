// The 1.0 execute-agent: autonomous case execution (docs/overview/agent-design.md).
//
// The case states WHAT to verify and what counts as pass (goal + alignment
// rules); the agent decides HOW (pages to open, buttons to click, APIs to
// call). The verdict is the structured three-way alignment: for every
// alignment entry, PRD logic (rule), frontend display (ui) and backend output
// (api) must be reported, with an explicit `match` judgement.

import type { AgentDefinition, HardLimits, JsonSchemaValue } from "./types.js";

/**
 * One three-way alignment entry (PRD logic / frontend display / backend
 * output). `match` is the agent's explicit judgement that all three agree.
 */
export const ALIGNMENT_ENTRY_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["rule", "api", "ui", "match"],
  properties: {
    rule: { type: "string", description: "PRD logic: what the case says must hold" },
    api: { type: "string", description: "Observed backend output (HTTP response and/or gRPC reply)" },
    ui: { type: "string", description: "Observed frontend display (page text / element content)" },
    match: { type: "boolean", description: "True when PRD logic, frontend display and backend output all agree" },
    notes: { type: "string", description: "Optional supporting observations (screenshots, request records)" },
  },
  additionalProperties: false,
};

/** Verdict schema: every alignment entry must carry all three sides. */
export const EXECUTE_AGENT_OUTPUT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["status", "summary", "alignments"],
  properties: {
    status: { enum: ["pass", "fail"] },
    summary: { type: "string", description: "One-paragraph human-readable outcome" },
    alignments: {
      type: "array",
      minItems: 1,
      items: ALIGNMENT_ENTRY_SCHEMA,
      description: "One entry per alignment the case asks to verify",
    },
  },
  additionalProperties: false,
};

/** Input schema: the (seed) case definition handed to the agent. */
export const EXECUTE_AGENT_INPUT_SCHEMA: JsonSchemaValue = {
  type: "object",
  required: ["caseId", "goal", "alignments"],
  properties: {
    caseId: { type: "string" },
    goal: { type: "string", description: "What this case verifies, in one sentence" },
    prdExcerpt: { type: "string", description: "Optional relevant PRD section" },
    alignments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["rule"],
        properties: {
          rule: { type: "string", description: "PRD logic that must hold" },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const EXECUTE_AGENT_ID = "execute-agent";

/** Default model id for the execute-agent (OpenAI via pi-ai catalog). */
export const EXECUTE_AGENT_DEFAULT_MODEL = "gpt-4.1-mini";

export const EXECUTE_AGENT_DEFAULT_LIMITS: HardLimits = {
  maxSteps: 32,
  tokenBudget: 400_000,
  timeoutMs: 300_000,
};

const SYSTEM_PROMPT_TEMPLATE = `You are the HPath execute-agent, an autonomous QA agent executing one test case end to end.

Case under test: {{input.caseId}}
Goal: {{input.goal}}

System under test: environment "{{env.name}}" at {{env.baseUrl}}.
Environment configuration (credentials, endpoints, seeded values — the current environment only): {{env.variables}}
Full case definition (alignment rules to verify): {{input}}

You are fully autonomous: the case states WHAT to verify; YOU decide how — which pages to open, which buttons to click, which APIs to call.

Procedure:
1. Use the browser tools to exercise the UI like a user (navigate, fill, click, wait). Read the page and take a screenshot where it matters.
2. Collect the backend side of the story with http_request (and grpc_call when the case names a gRPC service).
3. For every alignment rule in the case, record one observation with record_evidence containing at least: rule (PRD logic), api (observed backend output), ui (observed frontend display), match (true only when all three agree).
4. Finish EXACTLY ONCE with finish_verdict: status "pass" only when every recorded alignment entry has match=true; otherwise "fail". Every alignment entry in the verdict must carry rule, api, ui and match.

Rules:
- Never invent observations. Every api/ui value must come from a tool result in this run.
- If a step errors, adapt once; if it still fails, record the entry with match=false and return a fail verdict — evidence beats a crashed run.
- Stop after finish_verdict.`;

export interface ExecuteAgentOptions {
  /** Model id override (default EXECUTE_AGENT_DEFAULT_MODEL). */
  model?: string;
  /** Hard limit overrides (defaults EXECUTE_AGENT_DEFAULT_LIMITS). */
  hardLimits?: Partial<HardLimits>;
}

/** Build the 1.0 execute-agent definition. Register it on an AgentRegistry. */
export function createExecuteAgentDefinition(options: ExecuteAgentOptions = {}): AgentDefinition {
  return {
    id: EXECUTE_AGENT_ID,
    role: "autonomous case executor",
    systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
    toolBindings: ["browser", "http", "grpc"],
    model: options.model ?? EXECUTE_AGENT_DEFAULT_MODEL,
    hardLimits: { ...EXECUTE_AGENT_DEFAULT_LIMITS, ...options.hardLimits },
    inputSchema: EXECUTE_AGENT_INPUT_SCHEMA,
    outputSchema: EXECUTE_AGENT_OUTPUT_SCHEMA,
  };
}
