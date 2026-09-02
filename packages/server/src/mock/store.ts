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
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
