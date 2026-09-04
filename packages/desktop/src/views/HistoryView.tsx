// History view (T14): every recorded run of the selected project, filterable
// by env / case / status / date range, plus a per-case health strip (last N
// results). Both the table and the strip read the mock ListRuns endpoint —
// the table passes the filter fields through to the server, the strip works
// from the unfiltered run list. The project dimension of the filter is the
// app-wide project switcher in the sidebar, like every other view.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Case, Env, Run } from '@hpath/contract';
import { invokeListCases, invokeListRuns } from '../lib/ipc';
import { RunStatusTag } from '../components/Ui';
import {
  RUN_STATUS,
  formatDateTime,
  formatDuration,
  runStatusKey,
  runTagVariant,
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
};

// Results shown per case in the health strip.
const HEALTH_LAST_N = 10;

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

function HealthStrip({ results }: { results: Run[] }) {
  const { t } = useTranslation();
  const last = results.slice(0, HEALTH_LAST_N);
  const passed = results.filter((r) => r.status === RUN_STATUS.PASSED).length;
  return (
    <span className="hstrip">
      {last.map((r) => (
        <i
          key={r.id}
          className={`dot ${runTagVariant(r.status)}`}
          title={`${t(runStatusKey(r.status))} · ${formatDateTime(r.startedAt)}`}
        />
      ))}
      {last.length === 0 && <span className="dim">—</span>}
      {last.length > 0 && (
        <span className="dim num">
          {passed}/{results.length}
        </span>
      )}
    </span>
  );
}

function HistoryView({ appliedServerAddr, projectId, envs, refreshKey, onToast }: HistoryViewProps) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [cases, setCases] = useState<Case[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [allRuns, setAllRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  // Ticket guard: with a real (non-instant) server, rapid filter changes must
  // not let an older ListRuns response resolve last and paint wrong rows.
  const seq = useRef(0);

  // Reset when the project (or server) changes: filters are env/case-scoped.
  useEffect(() => {
    seq.current += 1;
    setFilters(EMPTY_FILTERS);
    setRuns([]);
    setAllRuns([]);
    setCases([]);
  }, [appliedServerAddr, projectId]);

  // One loader for the whole view: case names + health-strip data (unfiltered
  // run list) + the filtered table rows, guarded by a single ticket so stale
  // responses from an earlier filter/project can never land.
  const loadAll = useCallback(async () => {
    if (!projectId) return;
    const ticket = ++seq.current;
    setBusy(true);
    try {
      const [caseList, filtered, unfiltered] = await Promise.all([
        invokeListCases(projectId),
        invokeListRuns(projectId, {
          envId: filters.envId,
          caseId: filters.caseId,
          status: filters.status,
          from: filters.from ? dayBound(filters.from, false) : '',
          to: filters.to ? dayBound(filters.to, true) : '',
        }),
        invokeListRuns(projectId),
      ]);
      if (ticket !== seq.current) return;
      setCases(caseList);
      setRuns(sortRunsDesc(filtered));
      setAllRuns(sortRunsDesc(unfiltered));
    } catch (err) {
      if (ticket !== seq.current) return;
      onToast(String(err), true);
    } finally {
      if (ticket === seq.current) setBusy(false);
    }
  }, [projectId, filters, onToast]);

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
  // Health strip: most recent case activity first; never-run cases last.
  const healthCases = [...cases].sort((a, b) => {
    const ra = allRuns.find((r) => r.caseId === a.id)?.startedAt ?? '';
    const rb = allRuns.find((r) => r.caseId === b.id)?.startedAt ?? '';
    return ra < rb ? 1 : -1;
  });

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
            <select value={filters.envId} onChange={(e) => setFilter({ envId: e.target.value })}>
              <option value="">{t('topbar.allEnvs')}</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('cases.colCase')}</span>
            <select value={filters.caseId} onChange={(e) => setFilter({ caseId: e.target.value })}>
              <option value="">{t('history.allCases')}</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('cases.runStatus')}</span>
            <select
              value={filters.status}
              onChange={(e) => setFilter({ status: Number(e.target.value) })}
            >
              <option value={0}>{t('history.allStatuses')}</option>
              {[
                RUN_STATUS.PENDING,
                RUN_STATUS.RUNNING,
                RUN_STATUS.PASSED,
                RUN_STATUS.FAILED,
                RUN_STATUS.CANCELLED,
              ].map((s) => (
                <option key={s} value={s}>
                  {t(runStatusKey(s))}
                </option>
              ))}
            </select>
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

      <section className="sec">
        <div className="shead">
          <h2>{t('history.health')}</h2>
          <span className="n">{healthCases.length}</span>
          <span className="more">{t('history.healthLast', { n: HEALTH_LAST_N })}</span>
        </div>
        <div className="kv" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', rowGap: 10 }}>
          {healthCases.map((c) => (
            <HistoryHealthRow key={c.id} title={c.title} results={allRuns.filter((r) => r.caseId === c.id)} />
          ))}
          {healthCases.length === 0 && <p className="hint">{t('cases.empty')}</p>}
        </div>
      </section>
    </div>
  );
}

function HistoryHealthRow({ title, results }: { title: string; results: Run[] }) {
  return (
    <>
      <div className="v" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </div>
      <div>
        <HealthStrip results={results} />
      </div>
    </>
  );
}

export default HistoryView;
