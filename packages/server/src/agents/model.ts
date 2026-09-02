// Default model runtime for agent runs: pi-ai with an OpenAI API key from the
// server environment (see docs/overview/agent-design.md "OpenAI Access").
// Tests override both the model resolver and the stream function, so this
// module is only exercised on real runs.

import { createModels, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import type { ModelResolver } from "./types.js";

/**
 * Build the default model runtime. Providers come from the pi-ai catalog;
 * credentials resolve from the environment (OPENAI_API_KEY).
 */
export function createDefaultModels(): Models {
  return createModels();
}

/**
 * Resolve a model id against the pi-ai provider catalog (searched in provider
 * registration order). Throws a descriptive error for unknown model ids.
 */
export function createCatalogModelResolver(models: Models): ModelResolver {
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
