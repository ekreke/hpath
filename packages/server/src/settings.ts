// Model provider settings (chat + agent runtime): a JSON document persisted
// at HPATH_SETTINGS_PATH (default data/settings.json, cwd-relative like the
// SQLite db path). Seeded on first boot with the OpenAI-compatible providers
// from the user's opencode config; the multimodal flags below were verified
// against the live endpoints with an image-input probe (2026-09-03).
//
// Document shape (kept intentionally small and hand-editable):
// {
//   "providers": {
//     "ekreke": {
//       "name": "ekreke",
//       "baseUrl": "https://llm.ekreke.cn/v1",
//       "apiKey": "sk-...",
//       "models": [ { "id": "step-3.7-flash", "name": "Step 3.7 Flash", "multimodal": true } ]
//     }
//   },
//   "defaultModel": "deepseek-v4.1-flash",
//   "browserPool": 1,
//   "agents": { "execute-agent": { "model": "", "prompt": "" } }
// }
//
// Invariants enforced by validateSettings():
//   - at least one provider with a non-empty baseUrl
//   - every model has a non-empty unique id (unique within its provider)
//   - defaultModel references an existing model marked multimodal: the chat
//     page and the agents must be able to send screenshots
//   - browserPool is an integer in [0, MAX_BROWSER_POOL] (0 = pool disabled)
//   - agents[*].model (when set) references an existing model; prompts are
//     trimmed and capped at MAX_AGENT_PROMPT_CHARS

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

/**
 * Per-agent defaults (Settings view). `model` empty falls back to
 * SettingsDoc.defaultModel; `prompt` empty injects nothing. Keys are stable
 * agent registry ids ("execute-agent", "analyze-agent").
 */
export interface AgentSettings {
  model?: string;
  prompt?: string;
}

export interface SettingsDoc {
  providers: Record<string, ProviderConfig>;
  defaultModel: string;
  /**
   * Warm browser pool size (T23/T24): 0 disables the pool (launch per run,
   * current pre-T23 behavior); capped at MAX_BROWSER_POOL. Default 1.
   */
  browserPool: number;
  /**
   * Browser engine backing the browser tool provider (T24): exactly one of
   * BROWSER_ENGINES. An engine that is not installed is never silently
   * replaced by the other one — the browser tools are disabled instead.
   */
  browserEngine: BrowserEngineId;
  /**
   * Per-agent default model + prompt, keyed by agent id. Agents without an
   * entry (or with an empty model) use `defaultModel`; an absent/empty prompt
   * leaves the agent's built-in system prompt unchanged.
   */
  agents: Record<string, AgentSettings>;
}

/** Hard cap for a per-agent prompt (SettingsDoc.agents[*].prompt). */
export const MAX_AGENT_PROMPT_CHARS = 20_000;

/** Hard cap for SettingsDoc.browserPool — each pooled chromium is ~0.6-1 GB RSS. */
export const MAX_BROWSER_POOL = 4;

/** Default warm-browser pool size when the document omits browserPool. */
export const DEFAULT_BROWSER_POOL = 1;

/** Selectable browser engines (mutually exclusive). */
export const BROWSER_ENGINES = ["playwright", "obscura"] as const;

export type BrowserEngineId = (typeof BROWSER_ENGINES)[number];

/** Default browser engine when the document omits browserEngine. */
export const DEFAULT_BROWSER_ENGINE: BrowserEngineId = "playwright";

/** Type guard for a valid browser engine id. */
export function isBrowserEngineId(value: unknown): value is BrowserEngineId {
  return typeof value === "string" && (BROWSER_ENGINES as readonly string[]).includes(value);
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
 * First-boot seed: two OpenAI-compatible endpoints mirroring the user's
 * opencode config. `ekreke` (llm.ekreke.cn) keeps the multimodal models
 * step-3.7-flash / deepseek-v4-flash-vision-exp / qwen-max plus text-only
 * MiniMax-M3. `ekreke-copy` ("router", power.acme.red) serves
 * deepseek-v4.1-flash / glm-5.3-flash / glm-5.3 and is the default provider.
 * Each apiKey resolves from an env var (EKREKE_API_KEY / HPATH_ROUTER_API_KEY)
 * so no secret lands in the repository.
 */
export function seedSettings(): SettingsDoc {
  return {
    providers: {
      ekreke: {
        name: "ekreke",
        baseUrl: "https://llm.ekreke.cn/v1",
        apiKey: process.env.EKREKE_API_KEY ?? "",
        models: [
          { id: "step-3.7-flash", name: "Step 3.7 Flash", multimodal: true },
          { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Vision (exp)", multimodal: true },
          { id: "qwen-max", name: "Qwen Max", multimodal: true },
          { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3", multimodal: false },
        ],
      },
      "ekreke-copy": {
        name: "router",
        baseUrl: "http://power.acme.red/v1",
        apiKey: process.env.HPATH_ROUTER_API_KEY ?? "",
        models: [
          { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", multimodal: true },
          { id: "glm-5.3-flash", name: "GLM-5.3 Flash", multimodal: true },
          { id: "glm-5.3", name: "GLM-5.3", multimodal: false },
        ],
      },
    },
    defaultModel: "deepseek-v4.1-flash",
    browserPool: DEFAULT_BROWSER_POOL,
    browserEngine: DEFAULT_BROWSER_ENGINE,
    agents: {
      "execute-agent": {},
      "analyze-agent": {},
    },
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
  // Per-agent defaults: each model (when non-empty) must reference a
  // configured model; the prompt is trimmed and length-capped.
  const rawAgents = (value as Record<string, unknown>).agents;
  if (rawAgents !== undefined && (typeof rawAgents !== "object" || rawAgents === null || Array.isArray(rawAgents))) {
    throw new InvalidSettingsError("agents must be an object keyed by agent id");
  }
  const agents: Record<string, AgentSettings> = {};
  for (const [agentId, rawAgent] of Object.entries((rawAgents as Record<string, unknown>) ?? {})) {
    if (typeof agentId !== "string" || !agentId.trim()) {
      throw new InvalidSettingsError("agent ids must be non-empty strings");
    }
    if (typeof rawAgent !== "object" || rawAgent === null) {
      throw new InvalidSettingsError(`agent "${agentId}" must be an object`);
    }
    const { model, prompt } = rawAgent as Record<string, unknown>;
    if (model !== undefined && typeof model !== "string") {
      throw new InvalidSettingsError(`agent "${agentId}": model must be a string`);
    }
    if (typeof model === "string" && model.trim() !== "" && !allModels.has(model)) {
      throw new InvalidSettingsError(`agent "${agentId}": model "${model}" does not reference a configured model`);
    }
    if (prompt !== undefined && typeof prompt !== "string") {
      throw new InvalidSettingsError(`agent "${agentId}": prompt must be a string`);
    }
    const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (trimmedPrompt.length > MAX_AGENT_PROMPT_CHARS) {
      throw new InvalidSettingsError(
        `agent "${agentId}": prompt exceeds ${MAX_AGENT_PROMPT_CHARS} characters`,
      );
    }
    const entry: AgentSettings = {};
    if (typeof model === "string" && model.trim() !== "") entry.model = model.trim();
    if (trimmedPrompt !== "") entry.prompt = trimmedPrompt;
    agents[agentId] = entry;
  }
  (value as SettingsDoc).agents = agents;
  const rawPool = (value as Record<string, unknown>).browserPool;
  if (rawPool !== undefined) {
    if (typeof rawPool !== "number" || !Number.isInteger(rawPool) || rawPool < 0 || rawPool > MAX_BROWSER_POOL) {
      throw new InvalidSettingsError(
        `browserPool must be an integer in [0, ${MAX_BROWSER_POOL}] (0 disables the warm browser pool)`,
      );
    }
  }
  (value as SettingsDoc).browserPool = normalizeBrowserPool(rawPool);
  const rawEngine = (value as Record<string, unknown>).browserEngine;
  if (rawEngine !== undefined && !isBrowserEngineId(rawEngine)) {
    throw new InvalidSettingsError(
      `browserEngine must be one of ${BROWSER_ENGINES.join(", ")} (got ${JSON.stringify(rawEngine)})`,
    );
  }
  (value as SettingsDoc).browserEngine = normalizeBrowserEngine(rawEngine);
  return value as SettingsDoc;
}

/**
 * Clamp browserPool to a valid integer in [0, MAX_BROWSER_POOL]; absent or
 * invalid values fall back to the default. Non-throwing: stored documents
 * skip validation on load, so a hand-edit must not brick the pool sizing.
 */
export function normalizeBrowserPool(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_BROWSER_POOL) {
    return value;
  }
  return DEFAULT_BROWSER_POOL;
}

/**
 * Clamp browserEngine to a valid id; absent or invalid values fall back to the
 * default. Non-throwing: stored documents skip validation on load, so a
 * hand-edit must not brick browser startup.
 */
export function normalizeBrowserEngine(value: unknown): BrowserEngineId {
  return isBrowserEngineId(value) ? value : DEFAULT_BROWSER_ENGINE;
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
 * `defaultModelOverride`, `browserPoolOverride` and `browserEngineOverride`
 * replace the document's embedded values before validation, so the wire's
 * explicit fields win. An empty `browserEngineOverride` (proto3's default for
 * an omitted string field) is treated as "not provided".
 */
export function parseSettingsJson(
  json: string,
  defaultModelOverride?: string,
  browserPoolOverride?: number,
  browserEngineOverride?: string,
  agentsOverride?: { agentId: string; model?: string; prompt?: string }[],
): SettingsDoc {
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
  if (browserPoolOverride !== undefined) {
    doc.browserPool = browserPoolOverride;
  }
  // proto3 strings default to "" when the caller omits the field; treat that
  // as "not provided" so an omitted browser_engine keeps the embedded/default
  // value instead of failing validation.
  if (browserEngineOverride !== undefined && browserEngineOverride !== "") {
    doc.browserEngine = browserEngineOverride as BrowserEngineId;
  }
  // Per-agent overrides replace the document's entries for the same agent id;
  // an entry with both fields empty means "use the defaults".
  if (agentsOverride !== undefined) {
    const agents: Record<string, AgentSettings> = {};
    for (const entry of agentsOverride) {
      if (!entry.agentId) continue;
      const next: AgentSettings = {};
      if (entry.model && entry.model.trim() !== "") next.model = entry.model.trim();
      if (entry.prompt && entry.prompt.trim() !== "") next.prompt = entry.prompt.trim();
      agents[entry.agentId] = next;
    }
    doc.agents = agents;
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
    // hand-edit that breaks invariants should not brick server startup. The
    // browser pool size/engine are normalized best-effort (pre-T23/T24 docs
    // lack them).
    const stored = parsed as SettingsDoc;
    stored.browserPool = normalizeBrowserPool(stored.browserPool);
    stored.browserEngine = normalizeBrowserEngine(stored.browserEngine);
    // Pre-agents documents lack the field; an empty map keeps the fallback
    // (defaultModel / no prompt) without bricking startup.
    if (typeof stored.agents !== "object" || stored.agents === null || Array.isArray(stored.agents)) {
      stored.agents = {};
    }
    return new SettingsStore(path, stored);
  }

  get(): SettingsDoc {
    return this.doc;
  }

  /** Current warm browser pool size (normalized; 0 = pool disabled). */
  browserPoolSize(): number {
    return normalizeBrowserPool(this.doc.browserPool);
  }

  /** Current browser engine (normalized; always a valid id). */
  browserEngine(): BrowserEngineId {
    return normalizeBrowserEngine(this.doc.browserEngine);
  }

  /** Per-agent defaults for one agent id; empty when unset. */
  agentSettings(agentId: string): AgentSettings {
    const entry = this.doc.agents?.[agentId];
    return entry && typeof entry === "object" ? entry : {};
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
 * the configured per-agent model over the per-agent hardcode, falling back to
 * `defaultModel`. Exported as a ready-made BuiltInOptions fragment.
 */
export function agentModelOverrides(settings: SettingsStore): { executeAgent: { model: string }; analyzeAgent: { model: string } } {
  const fallback = settings.get().defaultModel;
  return {
    executeAgent: { model: settings.agentSettings("execute-agent").model ?? fallback },
    analyzeAgent: { model: settings.agentSettings("analyze-agent").model ?? fallback },
  };
}
