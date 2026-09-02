// Agent kernel public surface. The kernel, tools, and agents are separate
// modules; the server (and T8's real RunCase wiring) consumes them from here.

export { AgentRegistry } from "./registry.js";
export { InMemoryEventSink, CompositeEventSink } from "./events.js";
export type { AgentEventSink } from "./events.js";
export { AgentKernel } from "./pipeline.js";
export type { AgentKernelOptions, RunAgentInput } from "./pipeline.js";
export { validateSchema, assertSchema, schemaMatches } from "./schema.js";
export type { SchemaIssue } from "./schema.js";
export { renderTemplate } from "./template.js";
export type { TemplateVars } from "./template.js";
export { ToolProviderRegistry } from "./tools.js";
export type { ToolContext, ToolProvider } from "./tools.js";
export { VerdictChannel, createEvidenceToolProvider, createFinishVerdictTool } from "./verdict.js";
export { createDefaultModels, createCatalogModelResolver } from "./model.js";
export type {
  AgentDefinition,
  AgentRunEvent,
  AgentRunEventPayload,
  AgentRunFailureReason,
  AgentRunResult,
  EnvBinding,
  HardLimits,
  JsonSchemaValue,
  ModelResolver,
  Verdict,
} from "./types.js";
