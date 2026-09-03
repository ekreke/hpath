// Agent kernel public surface. The kernel, tools, and agents are separate
// modules; the server (and T8's real RunCase wiring) consumes them from here.

export { AgentRegistry } from "./registry.js";
export { InMemoryEventSink, CompositeEventSink } from "./events.js";
export type { AgentEventSink } from "./events.js";
export { RunEvidence } from "./evidence.js";
export type { CleanupFn } from "./evidence.js";
export { AgentKernel } from "./pipeline.js";
export type { AgentKernelOptions, RunAgentInput } from "./pipeline.js";
export { validateSchema, assertSchema, schemaMatches } from "./schema.js";
export type { SchemaIssue } from "./schema.js";
export { renderTemplate } from "./template.js";
export type { TemplateVars } from "./template.js";
export { ToolProviderRegistry } from "./tools.js";
export type { ToolContext, ToolProvider } from "./tools.js";
export {
  VerdictChannel,
  createEvidenceToolProvider,
  createFinishVerdictTool,
  createRecordEvidenceTool,
} from "./verdict.js";
export { createDefaultModels, createCatalogModelResolver } from "./model.js";
export { createBrowserToolProvider, createBrowserTools } from "./providers/browser.js";
export type { BrowserToolProviderOptions } from "./providers/browser.js";
export { createHttpToolProvider, createHttpRequestTool } from "./providers/http.js";
export type { HttpToolProviderOptions } from "./providers/http.js";
export { createGrpcToolProvider, createGrpcCallTool } from "./providers/grpc.js";
export type { GrpcToolProviderOptions } from "./providers/grpc.js";
export {
  ALIGNMENT_ENTRY_SCHEMA,
  EXECUTE_AGENT_ID,
  EXECUTE_AGENT_DEFAULT_LIMITS,
  EXECUTE_AGENT_DEFAULT_MODEL,
  EXECUTE_AGENT_INPUT_SCHEMA,
  EXECUTE_AGENT_OUTPUT_SCHEMA,
  createExecuteAgentDefinition,
} from "./execute-agent.js";
export type { ExecuteAgentOptions } from "./execute-agent.js";
export {
  createBuiltInAgentDefinitions,
  createBuiltInToolProviders,
  registerBuiltIns,
} from "./builtins.js";
export type { BuiltInOptions } from "./builtins.js";
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
