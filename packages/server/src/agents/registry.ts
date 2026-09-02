// AgentRegistry: the agent-level extension entry. Agents are registered
// AgentDefinitions; the kernel never hardcodes agent behavior.

import type { AgentDefinition } from "./types.js";

export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  /** Register a definition; duplicates are a programming error. */
  register(definition: AgentDefinition): this {
    validateDefinition(definition);
    if (this.definitions.has(definition.id)) {
      throw new Error(`agent definition "${definition.id}" already registered`);
    }
    this.definitions.set(definition.id, definition);
    return this;
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  get(id: string): AgentDefinition | undefined {
    return this.definitions.get(id);
  }

  /** Resolve a definition or throw with a clear message. */
  require(id: string): AgentDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new Error(`no agent definition registered for id "${id}"`);
    }
    return definition;
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()];
  }
}

function validateDefinition(definition: AgentDefinition): void {
  const required = (field: string, value: unknown): void => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`agent definition field "${field}" must be a non-empty string`);
    }
  };
  required("id", definition.id);
  required("role", definition.role);
  required("systemPromptTemplate", definition.systemPromptTemplate);
  required("model", definition.model);
  if (!Array.isArray(definition.toolBindings)) {
    throw new Error(`agent definition "${definition.id}": toolBindings must be an array`);
  }
  const limits = definition.hardLimits;
  if (!limits || typeof limits !== "object") {
    throw new Error(`agent definition "${definition.id}": hardLimits are required`);
  }
  const positive = (field: keyof typeof limits, value: unknown): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`agent definition "${definition.id}": hardLimits.${field} must be a positive number`);
    }
  };
  positive("maxSteps", limits.maxSteps);
  positive("tokenBudget", limits.tokenBudget);
  positive("timeoutMs", limits.timeoutMs);
  if (typeof definition.inputSchema !== "object" || definition.inputSchema === null) {
    throw new Error(`agent definition "${definition.id}": inputSchema is required`);
  }
  if (typeof definition.outputSchema !== "object" || definition.outputSchema === null) {
    throw new Error(`agent definition "${definition.id}": outputSchema is required`);
  }
}
