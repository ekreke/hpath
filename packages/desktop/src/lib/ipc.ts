// Typed Tauri IPC bindings. Payloads are serialized by the Rust side with
// camelCase field names, so types come straight from the generated protobuf
// definitions in @hpath/contract. The server address is not passed per call:
// it lives Rust-side (see set_server_addr) and is set once from the UI.
import type {
  Artifact,
  Case,
  Env,
  Prd,
  Project,
  Run,
  Verdict,
} from '@hpath/contract';
import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core';

export type {
  Artifact,
  Case,
  Env,
  Prd,
  Project,
  Run,
  Verdict,
};

export type ParseEvent = {
  kind: 'prdRegistered' | 'thinking' | 'progress' | 'draftsCreated' | 'error';
  prd?: Prd;
  text?: string;
  pct?: number;
  message?: string;
  caseIds?: string[];
  cases?: Case[];
  errorKind?: string;
  errorMessage?: string;
};

export type ParsePrdResult = {
  prd: Prd | null;
  drafts: Case[];
};

export type RunResult = {
  runId: string;
  status: number;
  failReason: string;
  verdict: Verdict | null;
};

// Tagged run event streamed from the Rust side on the `run-event` channel
// while run_case is in flight; `kind` selects which optional fields carry data.
export type RunEvent = {
  runId: string;
  seq: number;
  timestamp: string;
  kind:
    | 'agentText'
    | 'agentThinking'
    | 'toolStarted'
    | 'toolFinished'
    | 'screenshot'
    | 'requestRecord'
    | 'verdict'
    | 'error'
    | 'runStatus';
  text?: string;
  tool?: string;
  argsJson?: string;
  ok?: boolean;
  resultSummary?: string;
  artifactId?: string;
  caption?: string;
  direction?: string;
  method?: string;
  target?: string;
  requestJson?: string;
  responseJson?: string;
  verdict?: Verdict | null;
  errorKind?: string;
  errorMessage?: string;
  status?: number;
  reason?: string;
};

export type ListRunsFilter = {
  envId?: string;
  caseId?: string;
  status?: number;
  from?: string;
  to?: string;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

// All commands go through the @tauri-apps/api ES module (no dependency on the
// withGlobalTauri global). When the page runs in a plain browser tab (e.g. the
// raw vite dev URL), the IPC bridge is absent — reject with an actionable
// message instead of a cryptic TypeError.
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) {
    return Promise.reject(
      new Error(
        'Tauri IPC unavailable: this UI must run inside the desktop shell — start it with `make run` (or `tauri dev`), not in a browser tab.',
      ),
    );
  }
  return tauriInvoke<T>(cmd, args) as Promise<T>;
}

export function invokeSetServerAddr(addr: string): Promise<void> {
  return invoke<void>('set_server_addr', { addr });
}

export function invokeListProjects(): Promise<Project[]> {
  return invoke<Project[]>('list_projects');
}

export function invokeCreateProject(name: string, repoUrl: string): Promise<Project> {
  return invoke<Project>('create_project', { name, repoUrl });
}

export function invokeListEnvs(projectId: string): Promise<Env[]> {
  return invoke<Env[]>('list_envs', { projectId });
}

export function invokeUpsertEnv(env: Env): Promise<Env> {
  return invoke<Env>('upsert_env', { env });
}

export function invokeDeleteEnv(envId: string): Promise<void> {
  return invoke<void>('delete_env', { envId });
}

export function invokeListCases(projectId: string, status = 0): Promise<Case[]> {
  return invoke<Case[]>('list_cases', { projectId, status });
}

export function invokeGetCase(caseId: string): Promise<Case> {
  return invoke<Case>('get_case', { caseId });
}

export function invokeReviewCase(
  caseId: string,
  action: number,
  comment: string,
): Promise<Case> {
  return invoke<Case>('review_case', { caseId, action, comment });
}

export function invokeListRuns(projectId: string, filter: ListRunsFilter = {}): Promise<Run[]> {
  return invoke<Run[]>('list_runs', {
    projectId,
    envId: filter.envId ?? '',
    caseId: filter.caseId ?? '',
    status: filter.status ?? 0,
    from: filter.from ?? '',
    to: filter.to ?? '',
  });
}

export function invokeParsePrd(
  projectId: string,
  filename: string,
  format: number,
  contentBase64: string,
): Promise<ParsePrdResult> {
  return invoke<ParsePrdResult>('parse_prd', {
    projectId,
    filename,
    format,
    contentBase64,
  });
}

export function invokeRunCase(
  projectId: string,
  envId: string,
  caseId: string,
): Promise<RunResult> {
  return invoke<RunResult>('run_case', { projectId, envId, caseId });
}

// Base64-encoded artifact bytes (screenshots in the run panel; video / trace
// in the replay view). A channel always carries the download so callers can
// optionally surface a progress tick per received chunk — the session video
// always does, and timeline screenshots do when the artifact's sizeBytes is
// known (transcript-only screenshots have no total to report against).
export function invokeDownloadArtifact(
  artifactId: string,
  onProgress?: (progress: ArtifactProgress) => void,
): Promise<string> {
  const channel = new Channel<ArtifactProgress>();
  if (onProgress) {
    channel.onmessage = onProgress;
  }
  return invoke<string>('download_artifact', { artifactId, onProgress: channel });
}

// Progress tick for artifact downloads (bytes streamed so far; the expected
// total is known from the artifact's sizeBytes).
export type ArtifactProgress = {
  bytesReceived: number;
};

// Full run payload for the replay view (T13): the finished run, its recorded
// event stream (same tagged shape as the live `run-event` channel) and the
// artifact index.
export type RunDetailResult = {
  run: Run;
  events: RunEvent[];
  artifacts: Artifact[];
};

export function invokeGetRun(runId: string): Promise<RunDetailResult> {
  return invoke<RunDetailResult>('get_run', { runId });
}

// Writes the artifact bytes into the user's download dir; resolves with the
// written file's absolute path (T13: trace.zip download).
export function invokeSaveArtifact(artifactId: string, filename: string): Promise<string> {
  return invoke<string>('save_artifact', { artifactId, filename });
}

// Caches the trace.zip temp-side and launches `playwright show-trace` on it;
// resolves with the cached path (T13 one-click trace viewer).
export function invokeShowTrace(artifactId: string, runId: string): Promise<string> {
  return invoke<string>('show_trace', { artifactId, runId });
}

// Model provider settings (Settings view). providerConfigJson is an
// opencode-style provider document (baseUrl / apiKey / models with a
// multimodal flag); the server validates the shape and that defaultModel is
// multimodal-capable, failing with INVALID_ARGUMENT otherwise.
export type AppSettings = {
  providerConfigJson: string;
  defaultModel: string;
};

export function invokeGetSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_settings');
}

export function invokeUpdateSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>('update_settings', { settings });
}

// Tagged chat event streamed from the Rust side on the `chat-event` global
// channel (same pattern as `run-event`): one text delta per message or a
// terminal error.
export type ChatEvent =
  | { kind: 'textDelta'; text: string }
  | { kind: 'error'; message: string };

// Stream one chat turn against the configured default model; text deltas
// arrive via the `chat-event` channel and the promise resolves when the
// server ends the stream.
export function invokeChat(message: string): Promise<void> {
  return invoke<void>('chat', { message });
}
