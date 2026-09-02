// Status / enum metadata for rendering. Numeric values mirror the protobuf
// enums (proto/hpath/v1/hpath.proto); they cross the IPC boundary as numbers.
import type { TFunction } from 'i18next';

export const CASE_STATUS = {
  UNSPECIFIED: 0,
  DRAFT: 1,
  PENDING: 2,
  APPROVED: 3,
  DISABLED: 4,
} as const;

export const RUN_STATUS = {
  UNSPECIFIED: 0,
  PENDING: 1,
  RUNNING: 2,
  PASSED: 3,
  FAILED: 4,
  CANCELLED: 5,
} as const;

export const VERDICT_STATUS = {
  UNSPECIFIED: 0,
  PASSED: 1,
  FAILED: 2,
  INCONCLUSIVE: 3,
} as const;

export const REVIEW_ACTION = {
  APPROVE: 1,
  REJECT: 2,
  DISABLE: 3,
} as const;

export const PRD_FORMAT = {
  UNSPECIFIED: 0,
  MD: 1,
  DOCX: 2,
  PDF: 3,
} as const;

export function caseStatusKey(status: number): string {
  switch (status) {
    case CASE_STATUS.DRAFT: return 'status.draft';
    case CASE_STATUS.PENDING: return 'status.pending';
    case CASE_STATUS.APPROVED: return 'status.approved';
    case CASE_STATUS.DISABLED: return 'status.disabled';
    default: return 'status.unspecified';
  }
}

export function runStatusKey(status: number): string {
  switch (status) {
    case RUN_STATUS.PENDING: return 'status.pendingRun';
    case RUN_STATUS.RUNNING: return 'status.running';
    case RUN_STATUS.PASSED: return 'status.passed';
    case RUN_STATUS.FAILED: return 'status.failed';
    case RUN_STATUS.CANCELLED: return 'status.cancelled';
    default: return 'status.unspecified';
  }
}

/** Tag variant for run status pills: pass -> inverted outline, fail -> solid white. */
export function runTagVariant(status: number): 'pass' | 'fail' | 'muted' {
  if (status === RUN_STATUS.PASSED) return 'pass';
  if (status === RUN_STATUS.FAILED) return 'fail';
  return 'muted';
}

export function reviewActionsFor(status: number): number[] {
  // Mirrors the server-side transition table (mock/handlers.ts, T5 will own it).
  switch (status) {
    case CASE_STATUS.DRAFT:
    case CASE_STATUS.PENDING:
    case CASE_STATUS.DISABLED:
      return [REVIEW_ACTION.APPROVE];
    case CASE_STATUS.APPROVED:
      return [REVIEW_ACTION.DISABLE];
    default:
      return [];
  }
}

export function formatDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTime(iso: string, t: TFunction): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(t('format.locale'), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
