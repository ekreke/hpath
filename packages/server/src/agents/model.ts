// Default model runtime for agent runs: pi-ai with an OpenAI API key from the
// server environment (see docs/overview/agent-design.md "OpenAI Access").
// Tests override both the model resolver and the stream function, so this
// module is only exercised on real runs. Custom OpenAI-compatible providers
// from the settings document (settings.ts) register on top of the catalog.

import {
  createModels,
  createProvider,
  type Api,
  type ApiKeyAuth,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ProviderConfig } from "../settings.js";
import type { ModelResolver } from "./types.js";

/**
 * Build the default model runtime. Providers come from the pi-ai catalog;
 * credentials resolve from the environment (OPENAI_API_KEY).
 */
export function createDefaultModels(): MutableModels {
  return createModels();
}

/**
 * Register (or replace) a custom OpenAI-compatible provider built from the
 * settings document. Models run over the openai-completions API; the
 * multimodal flag maps to pi-ai's image input capability. Idempotent:
 * setProvider upserts by provider id, so re-registering after a settings
 * update is safe.
 */
export function registerProviderFromSettings(models: MutableModels, providerId: string, config: ProviderConfig): void {
  const providerModels: Model<Api>[] = config.models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    api: "openai-completions",
    provider: providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: model.multimodal ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 32768,
  }));
  const auth: ApiKeyAuth = {
    name: `${config.name ?? providerId} API key`,
    resolve: async () =>
      config.apiKey ? { auth: { apiKey: config.apiKey }, source: "settings.json" } : undefined,
  };
  models.setProvider(
    createProvider({
      id: providerId,
      name: config.name ?? providerId,
      baseUrl: config.baseUrl,
      auth: { apiKey: auth },
      models: providerModels,
      api: openAICompletionsApi(),
    }),
  );
}

/**
 * Register every provider in the settings document (call after loading or
 * updating settings so the runtime reflects the file).
 */
export function registerSettingsProviders(models: MutableModels, settings: { providers: Record<string, ProviderConfig> }): void {
  for (const [providerId, config] of Object.entries(settings.providers)) {
    registerProviderFromSettings(models, providerId, config);
  }
}

/**
 * Resolve a model id against the pi-ai provider catalog (searched in provider
 * registration order). Throws a descriptive error for unknown model ids.
 */
export function createCatalogModelResolver(models: MutableModels): ModelResolver {
  return (modelId: string): Model<Api> => {
    for (const provider of models.getProviders()) {
      const model = models.getModel(provider.id, modelId);
      if (model) {
        return model;
      }
    }
    throw new Error(
      `model "${modelId}" not found in the pi-ai provider catalog; check OPENAI_API_KEY and the agent definition's model id`,
    );
  };
}
