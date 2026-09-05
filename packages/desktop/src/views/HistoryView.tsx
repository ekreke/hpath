// History view (T14): every recorded run of the selected project, filterable
// by env / case / status / date range. The project dimension of the filter is
// the app-wide project switcher in the sidebar, like every other view. Per-case
// health lives in the case list (CasesView) at the same level as the case.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Case, Env, Run } from '@hpath/contract';
import { invokeListCases, invokeListRuns, isProjectNotFound, toFriendlyError } from '../lib/ipc';
import { RunStatusTag } from '../components/Ui';
import { Select } from '../components/Select';
import {
  RUN_STATUS,
  formatDateTime,
  formatDuration,
  runStatusKey,
  sortRunsDesc,
} from '../lib/status';

type HistoryViewProps = {
  appliedServerAddr: string;
  projectId: string | null;
  envs: Env[];
  // Bumped by App after a run finishes elsewhere (e.g. a re-run in CasesView):
  // the view re-queries so new runs show up without a manual refresh.
  refreshKey: number;
  onToast: (text: string, error?: boolean) => void;
  // Raised when the server confirms our selected project is gone. App uses it
  // to drop the stale selection and snap to the next valid project — without
  // this, every reload of this view would keep re-toasting the same NOT_FOUND.
  onProjectInvalidated?: (projectId: string) => void;
};

type Filters = {
  envId: string;
  caseId: string;
  status: number;
  from: string; // yyyy-mm-dd (inclusive, local)
  to: string; // yyyy-mm-dd (inclusive, local)
};

const EMPTY_FILTERS: Filters = { envId: '', caseId: '', status: 0, from: '', to: '' };

// Inclusive local-date bounds as ISO-8601 for ListRunsRequest.from/to. The
// end bound carries milliseconds: started_at is a ms-precision ISO string, so
// `:59.000` would drop runs started in the last 999 ms of the selected day.
function dayBound(date: string, endOfDay: boolean): string {
  return new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`).toISOString();
}

function triggerKey(trigger: number): string | null {
  if (trigger === 1) return 'runs.triggerManual';
  if (trigger === 2) return 'runs.triggerAgent';
  return null;
}

function HistoryView({
  appliedServerAddr,
  projectId,
  envs,
  refreshKey,
  onToast,
  onProjectInvalidated,
}: HistoryViewProps) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [cases, setCases] = useState<Case[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  // Ticket guard: with a real (non-instant) server, rapid filter changes must
  // not let an older ListRuns response resolve last and paint wrong rows.
  const seq = useRef(0);

  // Reset when the project (or server) changes: filters are env/case-scoped.
  useEffect(() => {
    seq.current += 1;
    setFilters(EMPTY_FILTERS);
    setRuns([]);
    setCases([]);
  }, [appliedServerAddr, projectId]);

  // One loader for the whole view: case names (for the case filter) plus the
  // filtered table rows, guarded by a single ticket so stale responses from an
  // earlier filter/project can never land.
  const loadAll = useCallback(async () => {
    if (!projectId) return;
    const ticket = ++seq.current;
    setBusy(true);
    try {
      const [caseList, filtered] = await Promise.all([
        invokeListCases(projectId),
        invokeListRuns(projectId, {
          envId: filters.envId,
          caseId: filters.caseId,
          status: filters.status,
          from: filters.from ? dayBound(filters.from, false) : '',
          to: filters.to ? dayBound(filters.to, true) : '',
        }),
      ]);
      if (ticket !== seq.current) return;
      setCases(caseList);
      setRuns(sortRunsDesc(filtered));
    } catch (err) {
      if (ticket !== seq.current) return;
      onToast(toFriendlyError(err).message, true);
      if (projectId && isProjectNotFound(err)) {
        onProjectInvalidated?.(projectId);
      }
    } finally {
      if (ticket === seq.current) setBusy(false);
    }
  }, [projectId, filters, onToast, onProjectInvalidated]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshKey]);

  if (!projectId) {
    return (
      <div className="page-inner">
        <div className="ph">
          <h1>{t('history.title')}</h1>
        </div>
        <p className="hint">{t('common.selectProjectFirst')}</p>
      </div>
    );
  }

  const caseTitle = (id: string) => cases.find((c) => c.id === id)?.title ?? id.slice(0, 8);
  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  const setFilter = (patch: Partial<Filters>) => setFilters((prev) => ({ ...prev, ...patch }));

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>{t('history.title')}</h1>
          <div className="path">{t('history.subtitle')}</div>
        </div>
        <div className="btns">
          <button className="btn ghost sm" disabled={busy} onClick={() => void loadAll()}>
            {t('history.refresh')}
          </button>
        </div>
      </div>

      <section className="sec">
        <div className="filters">
          <label>
            <span>{t('cases.runEnv')}</span>
            <Select
              ariaLabel={t('cases.runEnv')}
              value={filters.envId || null}
              placeholder={t('topbar.allEnvs')}
              options={envs.map((e) => ({ value: e.id, label: e.name }))}
              onChange={(envId) => setFilter({ envId })}
            />
          </label>
          <label>
            <span>{t('cases.colCase')}</span>
            <Select
              ariaLabel={t('cases.colCase')}
              value={filters.caseId || null}
              placeholder={t('history.allCases')}
              options={cases.map((c) => ({ value: c.id, label: c.title }))}
              onChange={(caseId) => setFilter({ caseId })}
            />
          </label>
          <label>
            <span>{t('cases.runStatus')}</span>
            <Select
              ariaLabel={t('cases.runStatus')}
              value={String(filters.status)}
              options={[
                { value: '0', label: t('history.allStatuses') },
                ...[
                  RUN_STATUS.PENDING,
                  RUN_STATUS.RUNNING,
                  RUN_STATUS.PASSED,
                  RUN_STATUS.FAILED,
                  RUN_STATUS.CANCELLED,
                ].map((s) => ({ value: String(s), label: t(runStatusKey(s)) })),
              ]}
              onChange={(v) => setFilter({ status: Number(v) })}
            />
          </label>
          <label>
            <span>{t('history.from')}</span>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter({ from: e.target.value })}
            />
          </label>
          <label>
            <span>{t('history.to')}</span>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter({ to: e.target.value })}
            />
          </label>
        </div>

        <table>
          <thead>
            <tr>
              <th>{t('runs.colTime')}</th>
              <th>{t('cases.colCase')}</th>
              <th>{t('runs.colEnv')}</th>
              <th>{t('runs.colTrigger')}</th>
              <th>{t('runs.colResult')}</th>
              <th className="num">{t('runs.colDuration')}</th>
              <th className="num">{t('runs.colTokens')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const tk = triggerKey(r.trigger);
              return (
                <tr key={r.id}>
                  <td className="dim num">{formatDateTime(r.startedAt)}</td>
                  <td className="mono" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {caseTitle(r.caseId)}
                  </td>
                  <td className="dim">{envName(r.envId)}</td>
                  <td className="dim">{tk ? t(tk) : '—'}</td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <RunStatusTag status={r.status} />
                      {r.failReason && <span className="dim mono">{r.failReason}</span>}
                    </span>
                  </td>
                  <td className="num">{formatDuration(r.durationMs)}</td>
                  <td className="num">{r.tokenCost ? `${r.tokenCost}` : '—'}</td>
                </tr>
              );
            })}
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">{t('history.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default HistoryView;
