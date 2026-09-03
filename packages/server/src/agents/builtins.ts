// Composition point for the 1.0 built-ins: registers the built-in tool
// providers and agent definitions on the two registries. The server (and T8's
// real RunCase wiring) builds its kernel from here; nothing in the pipeline
// hardcodes these ids.

import type { AgentRegistry } from "./registry.js";
import type { ToolProvider, ToolProviderRegistry } from "./tools.js";
import type { AgentDefinition } from "./types.js";
import { createExecuteAgentDefinition } from "./execute-agent.js";
import type { ExecuteAgentOptions } from "./execute-agent.js";
import { createAnalyzeAgentDefinition } from "./analyze-agent.js";
import type { AnalyzeAgentOptions } from "./analyze-agent.js";
import { createBrowserToolProvider } from "./providers/browser.js";
import { createGrpcToolProvider } from "./providers/grpc.js";
import { createHttpToolProvider } from "./providers/http.js";
import { createPrdAnalysisToolProvider } from "./providers/prd-analysis.js";
import type { BrowserToolProviderOptions, GrpcToolProviderOptions, HttpToolProviderOptions } from "./providers/index.js";
import { createEvidenceToolProvider } from "./verdict.js";

export interface BuiltInOptions {
  browser?: BrowserToolProviderOptions;
  http?: HttpToolProviderOptions;
  grpc?: GrpcToolProviderOptions;
  executeAgent?: ExecuteAgentOptions;
  analyzeAgent?: AnalyzeAgentOptions;
}

/** Create the 1.0 built-in tool providers (browser, http, grpc, evidence, prd-analysis). */
export function createBuiltInToolProviders(options: BuiltInOptions = {}): ToolProvider[] {
  return [
    createBrowserToolProvider(options.browser),
    createHttpToolProvider(options.http),
    createGrpcToolProvider(options.grpc),
    createEvidenceToolProvider(),
    createPrdAnalysisToolProvider(),
  ];
}

/** Create the 1.0 built-in agent definitions (execute-agent + analyze-agent). */
export function createBuiltInAgentDefinitions(options: BuiltInOptions = {}): AgentDefinition[] {
  return [
    createExecuteAgentDefinition(options.executeAgent),
    createAnalyzeAgentDefinition(options.analyzeAgent),
  ];
}

/** Register all 1.0 built-ins on both registries (idempotence is the caller's duty). */
export function registerBuiltIns(agents: AgentRegistry, toolProviders: ToolProviderRegistry, options: BuiltInOptions = {}): void {
  for (const provider of createBuiltInToolProviders(options)) {
    toolProviders.register(provider);
  }
  for (const definition of createBuiltInAgentDefinitions(options)) {
    agents.register(definition);
  }
}
