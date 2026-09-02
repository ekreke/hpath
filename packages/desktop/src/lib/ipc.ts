// Typed Tauri IPC bindings. Payloads are serialized by the Rust side with
// camelCase field names, so types come straight from the generated protobuf
// definitions in @hpath/contract.
import type {
  Case,
  Env,
  Prd,
  Project,
  Run,
  Verdict,
} from '@hpath/contract';

export type {
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

export type ListRunsFilter = {
  envId?: string;
  caseId?: string;
  status?: number;
  from?: string;
  to?: string;
};

declare global {
  interface Window {
    __TAURI__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.__TAURI__.invoke(cmd, args) as Promise<T>;
}

export function invokeListProjects(addr: string): Promise<Project[]> {
  return invoke<Project[]>('list_projects', { addr });
}

export function invokeListEnvs(addr: string, projectId: string): Promise<Env[]> {
  return invoke<Env[]>('list_envs', { addr, projectId });
}

export function invokeUpsertEnv(addr: string, env: Env): Promise<Env> {
  return invoke<Env>('upsert_env', { addr, env });
}

export function invokeDeleteEnv(addr: string, envId: string): Promise<void> {
  return invoke<void>('delete_env', { addr, envId });
}

export function invokeListCases(addr: string, projectId: string, status = 0): Promise<Case[]> {
  return invoke<Case[]>('list_cases', { addr, projectId, status });
}

export function invokeGetCase(addr: string, caseId: string): Promise<Case> {
  return invoke<Case>('get_case', { addr, caseId });
}

export function invokeReviewCase(
  addr: string,
  caseId: string,
  action: number,
  comment: string,
): Promise<Case> {
  return invoke<Case>('review_case', { addr, caseId, action, comment });
}

export function invokeListRuns(addr: string, projectId: string, filter: ListRunsFilter = {}): Promise<Run[]> {
  return invoke<Run[]>('list_runs', {
    addr,
    projectId,
    envId: filter.envId ?? '',
    caseId: filter.caseId ?? '',
    status: filter.status ?? 0,
    from: filter.from ?? '',
    to: filter.to ?? '',
  });
}

export function invokeParsePrd(
  addr: string,
  projectId: string,
  filename: string,
  format: number,
  contentBase64: string,
): Promise<ParsePrdResult> {
  return invoke<ParsePrdResult>('parse_prd', {
    addr,
    projectId,
    filename,
    format,
    contentBase64,
  });
}

export function invokeRunCase(
  addr: string,
  projectId: string,
  envId: string,
  caseId: string,
): Promise<RunResult> {
  return invoke<RunResult>('run_case', { addr, projectId, envId, caseId });
}
