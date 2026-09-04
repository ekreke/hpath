// Model provider settings (chat + agent runtime): a JSON document persisted
// at HPATH_SETTINGS_PATH (default data/settings.json, cwd-relative like the
// SQLite db path). Seeded on first boot with the ekreke OpenAI-compatible
// provider; the multimodal flags below were verified against the live
// endpoint with an image-input probe (2026-09-03).
//
// Document shape (kept intentionally small and hand-editable):
// {
//   "providers": {
//     "ekreke": {
//       "name": "ekreke",
//       "baseUrl": "https://llm.ekreke.cn/v1",
//       "apiKey": "sk-...",
//       "models": [ { "id": "glm-5.3-flash", "name": "GLM-5.3 Flash", "multimodal": true } ]
//     }
//   },
//   "defaultModel": "glm-5.3-flash"
// }
//
// Invariants enforced by validateSettings():
//   - at least one provider with a non-empty baseUrl
//   - every model has a non-empty unique id (unique within its provider)
//   - defaultModel references an existing model marked multimodal: the chat
//     page and the agents must be able to send screenshots.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ProviderModelConfig {
  id: string;
  name?: string;
  /** Model accepts image input (vision). Required for the default model. */
  multimodal?: boolean;
}

export interface ProviderConfig {
  name?: string;
  baseUrl: string;
  apiKey: string;
  models: ProviderModelConfig[];
}

export interface SettingsDoc {
  providers: Record<string, ProviderConfig>;
  defaultModel: string;
}

/** Thrown for structurally invalid settings; maps to INVALID_ARGUMENT. */
export class InvalidSettingsError extends Error {}

/** Default settings file location, relative to the working directory. */
export const DEFAULT_SETTINGS_PATH = "data/settings.json";

/** Settings path from HPATH_SETTINGS_PATH, falling back to data/settings.json. */
export function defaultSettingsPath(): string {
  return process.env.HPATH_SETTINGS_PATH ?? DEFAULT_SETTINGS_PATH;
}

/**
 * First-boot seed: the ekreke OpenAI-compatible endpoint (baseURL/apiKey from
 * the user's opencode config), with multimodal flags from the live probe:
 * glm-5.3-flash / step-3.7-flash / deepseek-v4-flash-vision-exp / qwen-max
 * accept image input; glm-5.3 is text-only. The apiKey resolves from the
 * EKREKE_API_KEY env var so no secret lands in the repository.
 */
export function seedSettings(): SettingsDoc {
  return {
    providers: {
      ekreke: {
        name: "ekreke",
        baseUrl: "https://llm.ekreke.cn/v1",
        apiKey: process.env.EKREKE_API_KEY ?? "",
        models: [
          { id: "glm-5.3-flash", name: "GLM-5.3 Flash", multimodal: true },
          { id: "step-3.7-flash", name: "Step 3.7 Flash", multimodal: true },
          { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Vision (exp)", multimodal: true },
          { id: "qwen-max", name: "Qwen Max", multimodal: true },
          { id: "glm-5.3", name: "GLM-5.3", multimodal: false },
          { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", multimodal: false },
        ],
      },
    },
    defaultModel: "glm-5.3-flash",
  };
}

/**
 * Validate an unknown parsed document into a SettingsDoc. Throws
 * InvalidSettingsError with a user-facing message on any violation.
 */
export function validateSettings(value: unknown): SettingsDoc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidSettingsError("settings must be a JSON object");
  }
  const { providers, defaultModel } = value as Record<string, unknown>;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    throw new InvalidSettingsError("providers must be an object keyed by provider id");
  }
  const entries = Object.entries(providers as Record<string, unknown>);
  if (entries.length === 0) {
    throw new InvalidSettingsError("at least one provider is required");
  }
  const allModels = new Set<string>();
  for (const [providerId, rawProvider] of entries) {
    if (typeof providerId !== "string" || !providerId.trim()) {
      throw new InvalidSettingsError("provider ids must be non-empty strings");
    }
    if (typeof rawProvider !== "object" || rawProvider === null) {
      throw new InvalidSettingsError(`provider "${providerId}" must be an object`);
    }
    const { name, baseUrl, apiKey, models } = rawProvider as Record<string, unknown>;
    if (typeof baseUrl !== "string" || !baseUrl.trim()) {
      throw new InvalidSettingsError(`provider "${providerId}": baseUrl is required`);
    }
    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new InvalidSettingsError(`provider "${providerId}": apiKey must be a string`);
    }
    if (!Array.isArray(models) || models.length === 0) {
      throw new InvalidSettingsError(`provider "${providerId}": models must be a non-empty array`);
    }
    const seen = new Set<string>();
    for (const rawModel of models) {
      if (typeof rawModel !== "object" || rawModel === null) {
        throw new InvalidSettingsError(`provider "${providerId}": models must be objects`);
      }
      const { id, modelName, multimodal } = rawModel as Record<string, unknown>;
      if (typeof id !== "string" || !id.trim()) {
        throw new InvalidSettingsError(`provider "${providerId}": every model needs a non-empty id`);
      }
      if (seen.has(id)) {
        throw new InvalidSettingsError(`provider "${providerId}": duplicate model id "${id}"`);
      }
      seen.add(id);
      if (allModels.has(id)) {
        throw new InvalidSettingsError(`model id "${id}" appears in more than one provider`);
      }
      allModels.add(id);
      if (modelName !== undefined && typeof modelName !== "string") {
        throw new InvalidSettingsError(`provider "${providerId}" model "${id}": name must be a string`);
      }
      if (multimodal !== undefined && typeof multimodal !== "boolean") {
        throw new InvalidSettingsError(`provider "${providerId}" model "${id}": multimodal must be a boolean`);
      }
    }
    void name;
  }
  if (typeof defaultModel !== "string" || !defaultModel.trim()) {
    throw new InvalidSettingsError("defaultModel is required");
  }
  const located = findModel(entries, defaultModel);
  if (!located) {
    throw new InvalidSettingsError(`defaultModel "${defaultModel}" does not reference a configured model`);
  }
  if (!located.multimodal) {
    throw new InvalidSettingsError(
      `defaultModel "${defaultModel}" is not multimodal — the chat page and the agents need image input (screenshots)`,
    );
  }
  return value as SettingsDoc;
}

/** Locate a model id across providers; returns its multimodal flag when found. */
function findModel(
  entries: [string, unknown][],
  modelId: string,
): { providerId: string; multimodal: boolean } | undefined {
  for (const [providerId, rawProvider] of entries) {
    const { models } = rawProvider as Record<string, unknown>;
    if (!Array.isArray(models)) continue;
    for (const rawModel of models) {
      const candidate = rawModel as Record<string, unknown>;
      if (candidate.id === modelId) {
        return { providerId, multimodal: candidate.multimodal === true };
      }
    }
  }
  return undefined;
}

/**
 * Parse + validate a settings JSON string (the wire format of AppSettings).
 * `defaultModelOverride` replaces the document's embedded defaultModel before
 * validation, so the wire's explicit field wins.
 */
export function parseSettingsJson(json: string, defaultModelOverride?: string): SettingsDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new InvalidSettingsError(`provider config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const doc = parsed as SettingsDoc;
  if (defaultModelOverride !== undefined) {
    doc.defaultModel = defaultModelOverride;
  }
  return validateSettings(doc);
}

/** Loaded settings view handed to handlers and the model runtime. */
export class SettingsStore {
  private doc: SettingsDoc;

  private constructor(private readonly path: string, doc: SettingsDoc) {
    this.doc = doc;
  }

  /** Load from disk; seeds the file on first boot. */
  static load(path: string = defaultSettingsPath()): SettingsStore {
    if (!existsSync(path)) {
      const seed = seedSettings();
      if (!seed.providers.ekreke?.apiKey) {
        console.warn(
          "[hpath-server] settings seed: EKREKE_API_KEY not set — chat/agent calls will fail until a key is configured (Settings view or env)",
        );
      }
      const store = new SettingsStore(path, seed);
      store.persist();
      return store;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(
        `settings file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Stored docs skip validation: they were validated when written, and a
    // hand-edit that breaks invariants should not brick server startup.
    return new SettingsStore(path, parsed as SettingsDoc);
  }

  get(): SettingsDoc {
    return this.doc;
  }

  /** Validate + persist a new document atomically (validated on the way in). */
  update(next: SettingsDoc): SettingsDoc {
    const validated = validateSettings(JSON.parse(JSON.stringify(next)));
    this.doc = validated;
    this.persist();
    return this.doc;
  }

  /** Resolve the default model against the current doc; throws when unset. */
  resolveDefaultModel(): { providerId: string; model: ProviderModelConfig; provider: ProviderConfig } {
    const entries = Object.entries(this.doc.providers);
    const located = findModel(entries, this.doc.defaultModel);
    if (!located) {
      throw new InvalidSettingsError(`defaultModel "${this.doc.defaultModel}" is not configured`);
    }
    const provider = this.doc.providers[located.providerId]!;
    const model = (provider.models as ProviderModelConfig[]).find((m) => m.id === this.doc.defaultModel)!;
    return { providerId: located.providerId, model, provider };
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.doc, null, 2)}\n`, "utf8");
  }
}

/**
 * Model override for the built-in agent definitions, wired from settings so
 * kernel construction (registerBuiltIns call sites, T8 run creation) prefers
 * the configured default model over the per-agent hardcode. Exported as a
 * ready-made BuiltInOptions fragment.
 */
export function agentModelOverrides(settings: SettingsStore): { executeAgent: { model: string }; analyzeAgent: { model: string } } {
  const model = settings.get().defaultModel;
  return { executeAgent: { model }, analyzeAgent: { model } };
}
