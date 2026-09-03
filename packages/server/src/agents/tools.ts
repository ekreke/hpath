// Tool-level extension entry: tools always come from ToolProviders, never from
// inline literals in agent code. Providers are registered by id and bound to
// agents via AgentDefinition.toolBindings.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EnvBinding, Verdict } from "./types.js";
import type { AgentEventSink } from "./events.js";
import type { VerdictChannel } from "./verdict.js";
import type { RunEvidence } from "./evidence.js";

/** Per-run context handed to providers when materializing their tools. */
export interface ToolContext {
  runId: string;
  agentId: string;
  /** Env-bound injection: only the current env's targets/variables are visible. */
  env: EnvBinding;
  /** Validated run input. */
  input: unknown;
  /** Event pipe for tool-side recording (screenshots, request records, ...). */
  events: AgentEventSink;
  /** Structured verdict channel (kernel-owned). */
  verdict: VerdictChannel;
  /** Run-scoped evidence store + resource cleanup registry (kernel-owned). */
  evidence: RunEvidence;
}

export interface ToolProvider {
  /** Registry id, e.g. "browser", "http", "grpc", "evidence". */
  id: string;
  description: string;
  /** Create the provider's tools bound to one specific run. Called once per run. */
  createTools(context: ToolContext): AgentTool[];
}

export class ToolProviderRegistry {
  private readonly providers = new Map<string, ToolProvider>();

  /** Register a provider; duplicates are a programming error. */
  register(provider: ToolProvider): this {
    if (!provider.id || provider.id.trim() === "") {
      throw new Error("tool provider id must be a non-empty string");
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`tool provider "${provider.id}" already registered`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ToolProvider | undefined {
    return this.providers.get(id);
  }

  /** Resolve a provider or throw with a clear message. */
  require(id: string): ToolProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`no tool provider registered for id "${id}"`);
    }
    return provider;
  }

  list(): ToolProvider[] {
    return [...this.providers.values()];
  }
}
