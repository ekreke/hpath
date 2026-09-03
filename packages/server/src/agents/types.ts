// Agent kernel types: registered agent definitions, hard limits, run outcomes.
//
// Architecture invariant: agents are *registered definitions*, never hardcoded
// branches. The kernel (pipeline, registries) only knows `AgentDefinition`;
// adding an agent means registering a definition. See docs/overview/agent-design.md.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { RunStatus } from "@hpath/contract";

/** Wall-clock and budget caps for a single agent run, enforced by the kernel. */
export interface HardLimits {
  /** Maximum number of LLM turns (assistant responses) per run. */
  maxSteps: number;
  /** Cumulative input+output token cap across all turns of a run. */
  tokenBudget: number;
  /** Wall-clock cap in milliseconds for the whole run. */
  timeoutMs: number;
}

/**
 * A registerable agent. All 1.0 agents (analyze-agent, execute-agent) are
 * instances of this interface; the shared run pipeline executes any of them
 * unchanged.
 */
export interface AgentDefinition {
  /** Unique registry id, e.g. "execute-agent". */
  id: string;
  /** Human-readable role, e.g. "autonomous case executor". */
  role: string;
  /**
   * System prompt template. Placeholders `{{env.<field>}}` and `{{input}}`
   * are resolved at run start against the *current* env binding and the
   * validated run input (env-bound injection: only the current env is ever
   * visible to the agent).
   */
  systemPromptTemplate: string;
  /** ToolProvider ids whose tools this agent may use, e.g. ["browser", "http"]. */
  toolBindings: string[];
  /** LLM model id resolved through the pi-ai provider catalog. */
  model: string;
  /** Kernel-enforced limits; on breach the run stops and evidence is preserved. */
  hardLimits: HardLimits;
  /** JSON Schema (subset) the run input must satisfy. */
  inputSchema: JsonSchemaValue;
  /**
   * JSON Schema (subset) the structured verdict must satisfy. The verdict is
   * submitted through the kernel's `finish_verdict` tool and validated against
   * this schema before the run may succeed.
   */
  outputSchema: JsonSchemaValue;
}

/** Plain JSON Schema value (subset supported by ./schema.ts). */
export type JsonSchemaValue = Record<string, unknown>;

/** The environment a run is bound to. Other envs are invisible to the run. */
export interface EnvBinding {
  projectId: string;
  envId: string;
  /** Display name, e.g. "dev". */
  name: string;
  /** Base URL of the system under test in this env. */
  baseUrl: string;
  /** Env variables injected into the system prompt / tool configuration. */
  variables: Record<string, string>;
}

/** Structured verdict submitted via the kernel `finish_verdict` tool. */
export type Verdict = Record<string, unknown>;

/** Why a run did not succeed. */
export type AgentRunFailureReason =
  | "input_schema"
  | "template"
  | "no_verdict"
  | "invalid_verdict"
  | "agent_error"
  | `limit:${"max_steps" | "token_budget" | "timeout_ms"}`;

/** Kernel-level run event payload; persisted/streamed by callers (T8 maps to proto Event). */
export type AgentRunEventPayload =
  | { kind: "run_status"; status: RunStatus; reason: string }
  | { kind: "agent_text"; text: string }
  | { kind: "agent_thinking"; text: string }
  | { kind: "tool_started"; tool: string; argsJson: string }
  | { kind: "tool_finished"; tool: string; ok: boolean; resultSummary: string }
  | { kind: "verdict"; verdict: Verdict }
  /** One structured observation recorded via the `record_evidence` tool. */
  | { kind: "evidence_recorded"; entry: Verdict }
  /**
   * Screenshot captured by the browser provider; kept inline as base64 for
   * now — T8 redirects binary evidence to the artifact store.
   */
  | { kind: "screenshot"; label: string; mime: string; base64: string }
  | { kind: "error"; errorKind: string; message: string };

/** One recorded run event. `seq` is 1-based and ordered per run. */
export interface AgentRunEvent {
  runId: string;
  seq: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  payload: AgentRunEventPayload;
}

/** Terminal result of a pipeline run. */
export interface AgentRunResult {
  runId: string;
  agentId: string;
  /** PASSED only when a schema-valid verdict was recorded, else FAILED. */
  status: RunStatus;
  /** The structured verdict, when one was recorded. */
  verdict?: Verdict;
  /** Empty when the run ended with a verdict; e.g. "limit:max_steps" otherwise. */
  failReason: AgentRunFailureReason | "";
  /** Cumulative input+output tokens reported by the model. */
  tokenCost: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** All events collected during the run, in order (evidence is never dropped). */
  events: AgentRunEvent[];
}

/** Resolves a definition's model id to a concrete pi-ai model descriptor. */
export type ModelResolver = (modelId: string) => Model<Api>;
