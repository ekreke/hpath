// In-memory mock data store. Backs the `--mock` server mode until the real
// SQLite implementations land (T5+). Reset on every server restart.

import type {
  Artifact,
  Case,
  Env,
  Event,
  Project,
  Prd,
  Run,
} from "@hpath/contract";

export interface MockStore {
  projects: Map<string, Project>;
  envs: Map<string, Env>;
  cases: Map<string, Case>;
  runs: Map<string, Run>;
  /** run id -> ordered events */
  events: Map<string, Event[]>;
  /** artifact id -> metadata */
  artifacts: Map<string, Artifact>;
  /** artifact id -> bytes */
  artifactData: Map<string, Uint8Array>;
  prds: Map<string, Prd>;
  /** Model provider settings (GetSettings/UpdateSettings); mock-only memory. */
  settings: { providerConfigJson: string; defaultModel: string };
}

export function createMockStore(): MockStore {
  return {
    projects: new Map(),
    envs: new Map(),
    cases: new Map(),
    runs: new Map(),
    events: new Map(),
    artifacts: new Map(),
    artifactData: new Map(),
    prds: new Map(),
    settings: { providerConfigJson: JSON.stringify(SEED_PROVIDER_JSON, null, 2), defaultModel: "glm-5.3-flash" },
  };
}

/**
 * Seed provider document for mock mode (display + edit round-trip in the
 * Settings view). Mirrors the real-mode seed shape (settings.ts) minus the
 * secret: the apiKey is a placeholder in mock mode.
 */
export const SEED_PROVIDER_JSON = {
  providers: {
    ekreke: {
      name: "ekreke (mock)",
      baseUrl: "https://llm.ekreke.cn/v1",
      apiKey: "sk-mock",
      models: [
        { id: "glm-5.3-flash", name: "GLM-5.3 Flash", multimodal: true },
        { id: "step-3.7-flash", name: "Step 3.7 Flash", multimodal: true },
        { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Vision (exp)", multimodal: true },
        { id: "qwen-max", name: "Qwen Max", multimodal: true },
        { id: "glm-5.3", name: "GLM-5.3", multimodal: false },
      ],
    },
  },
  defaultModel: "glm-5.3-flash",
};

export function nowIso(): string {
  return new Date().toISOString();
}
