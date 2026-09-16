// Cases view: case list (creator/status/last-run) + case detail with review
// actions, env strip, run history (with T13 replay), and the run trigger with
// the live panel (T12).
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import type { Case, Env, Run } from '@hpath/contract';
import {
  invokeBatchRunCases,
  invokeControlRun,
  invokeDeleteCase,
  invokeGetCase,
  invokeGetRun,
  invokeListCases,
  invokeListRuns,
  invokeReviewCase,
  invokeRunCase,
  type BatchRunEvent,
  type BatchRunResult,
  type RunDetailResult,
  type RunEvent,
  type RunResult,
} from '../lib/ipc';
import { Select } from '../components/Select';
import {
  CASE_STATUS,
  REVIEW_ACTION,
  RUN_STATUS,
  caseEditableFor,
  caseStatusKey,
  formatDateTime,
  formatDuration,
  formatTime,
  reviewActionsFor,
  runStatusKey,
  sortRunsDesc,
} from '../lib/status';
import { CaseStatusBadge, RunStatusTag } from '../components/Ui';
import { HealthStrip } from '../components/HealthStrip';
import RunPanel from '../components/RunPanel';
import CaseFormModal from '../components/CaseFormModal';

type CasesViewProps = {
  appliedServerAddr: string;
  projectId: string | null;
  envs: Env[];
  selectedEnvId: string | null;
  refreshKey: number;
  onToast: (text: string, error?: boolean) => void;
  onCountChange: (count: number) => void;
  onOpenEnvs: () => void;
  onSelectEnv: (id: string | null) => void;
};

function creatorLabel(kase: Case, t: (key: string) => string): string {
  if (!kase.creator) return '—';
  if (kase.creator.type === 2) return `${t('cases.creatorAgent')} · ${kase.creator.name}`;
  return kase.creator.name || t('cases.creatorHuman');
}

function lastRunOf(runs: Run[], caseId: string): Run | undefined {
  return runs
    .filter((r) => r.caseId === caseId && (r.status === RUN_STATUS.PASSED || r.status === RUN_STATUS.FAILED || r.status === RUN_STATUS.CANCELLED))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
}

// Per-case live state of a batch execution (list multi-select): the child
// run's id, its latest status and the events buffered so far, so the detail
// live panel can replay them when a case is opened mid-batch.
type BatchCaseState = {
  runId: string;
  status: number;
  reason: string;
  events: RunEvent[];
};

function isRunActive(status: number): boolean {
  return (
    status === RUN_STATUS.PENDING ||
    status === RUN_STATUS.RUNNING ||
    status === RUN_STATUS.PAUSED
  );
}

function CasesView({
  appliedServerAddr,
  projectId,
  envs,
  selectedEnvId,
  refreshKey,
  onToast,
  onCountChange,
  onOpenEnvs,
  onSelectEnv,
}: CasesViewProps) {
  const { t } = useTranslation();
  const [cases, setCases] = useState<Case[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Case | null>(null);
  const [detailRuns, setDetailRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  const [runFinal, setRunFinal] = useState<Run | null>(null);
  // Replay of a finished run (T13): panel + fetched run detail.
  const [replayRun, setReplayRun] = useState<Run | null>(null);
  const [replayDetail, setReplayDetail] = useState<RunDetailResult | null>(null);
  // Env the live panel was actually triggered with: a re-run targets the
  // replayed run's original env, which may differ from the TopBar selection.
  const [runEnvId, setRunEnvId] = useState<string | null>(null);
  // Ticket guard for openReplay: rapid clicks must not let a stale get_run
  // response overwrite the newer replay.
  const replaySeq = useRef(0);
  // Ticket guard for openCase: rapid clicks must not let a stale get_case /
  // list_runs response overwrite the detail of a case opened later.
  const caseSeq = useRef(0);
  // Manual case management (create/edit modal): null = create mode.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Case | null>(null);
  // Batch execution (list multi-select): selection + per-case live state.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchActive, setBatchActive] = useState(false);
  const [batchStopping, setBatchStopping] = useState(false);
  const [batchConcurrency, setBatchConcurrency] = useState(2);
  const [batchSummary, setBatchSummary] = useState<BatchRunResult | null>(null);
  const [batchRuns, setBatchRuns] = useState<Record<string, BatchCaseState>>({});
  // Refs mirroring state for use inside event-stream / async callbacks, where
  // the captured closure would otherwise read a stale value.
  const batchRunsRef = useRef(batchRuns);
  const batchEnvRef = useRef<string | null>(null);
  const selectedCaseIdRef = useRef<string | null>(null);
  const runToCaseRef = useRef<Map<string, string>>(new Map());
  const headCheckRef = useRef<HTMLInputElement>(null);
  // Set while the user asked to stop a batch: queued cases that start after
  // the request are cancelled as soon as their run id is announced.
  const stoppingRef = useRef(false);
  useEffect(() => {
    batchRunsRef.current = batchRuns;
  }, [batchRuns]);
  useEffect(() => {
    selectedCaseIdRef.current = selectedCaseId;
  }, [selectedCaseId]);
  useEffect(() => {
    setSelectedCaseId(null);
    setDetail(null);
    setDetailRuns([]);
    setRunResult(null);
    setRunOpen(false);
    setRunEvents([]);
    setRunFinal(null);
    setReplayRun(null);
    setReplayDetail(null);
    setRunEnvId(null);
    replaySeq.current += 1;
    caseSeq.current += 1;
    setSelectedIds(new Set());
    setBatchRuns({});
    setBatchSummary(null);
    setBatchActive(false);
    setBatchStopping(false);
    batchEnvRef.current = null;
    runToCaseRef.current = new Map();
    if (!projectId) {
      setCases([]);
      setRuns([]);
      onCountChange(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [caseList, runList] = await Promise.all([
          invokeListCases(projectId),
          invokeListRuns(projectId),
        ]);
        if (cancelled) return;
        setCases(caseList);
        setRuns(runList);
        onCountChange(caseList.length);
      } catch (err) {
        if (!cancelled) onToast(String(err), true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedServerAddr, projectId, refreshKey]);

  const openCase = useCallback(
    async (caseId: string) => {
      const ticket = ++caseSeq.current;
      // Opening a case clears the replay panel, so an in-flight replay
      // response must not repopulate it.
      replaySeq.current += 1;
      setSelectedCaseId(caseId);
      // A case in an in-flight batch opens with its live run panel: buffered
      // events seed the feed and the batch stream appends later ones.
      const batchState = batchRunsRef.current[caseId];
      const batchEnv = batchEnvRef.current;
      const live = batchState && isRunActive(batchState.status) ? batchState : undefined;
      setRunOpen(Boolean(live));
      setRunEnvId(live && batchEnv ? batchEnv : null);
      setRunEvents(live ? live.events : []);
      setRunFinal(null);
      setRunBusy(Boolean(live));
      setRunResult(null);
      setReplayRun(null);
      setReplayDetail(null);
      setBusy(true);
      try {
        const [caseDetail, runList] = await Promise.all([
          invokeGetCase(caseId),
          invokeListRuns(projectId ?? '', { caseId }),
        ]);
        if (ticket !== caseSeq.current) return;
        setDetail(caseDetail);
        setDetailRuns(sortRunsDesc(runList));
      } catch (err) {
        if (ticket !== caseSeq.current) return;
        onToast(String(err), true);
      } finally {
        if (ticket === caseSeq.current) setBusy(false);
      }
    },
    [projectId, onToast],
  );

  const applyReview = async (action: number) => {
    if (!detail) return;
    setBusy(true);
    try {
      const updated = await invokeReviewCase(
        detail.id,
        action,
        t(`cases.reviewLog.${action === REVIEW_ACTION.APPROVE ? 'approve' : action === REVIEW_ACTION.REJECT ? 'reject' : 'disable'}`),
      );
      setDetail(updated);
      setCases((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      onToast(t(`cases.reviewDone.${action === REVIEW_ACTION.APPROVE ? 'approve' : action === REVIEW_ACTION.REJECT ? 'reject' : 'disable'}`));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  // Re-fetch the case list (after create/update/delete) without bumping the
  // parent refreshKey.
  const reloadCases = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await invokeListCases(projectId);
      setCases(list);
      onCountChange(list.length);
    } catch (err) {
      onToast(String(err), true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const onCaseSaved = async (saved: Case) => {
    setFormOpen(false);
    await reloadCases();
    // Editing from the detail page: refresh the open detail in place.
    if (selectedCaseId === saved.id) await openCase(saved.id);
  };

  const deleteCurrentCase = async () => {
    if (!detail) return;
    if (!window.confirm(t('cases.deleteConfirm', { title: detail.title }))) return;
    setBusy(true);
    try {
      await invokeDeleteCase(detail.id);
      onToast(t('cases.deleted'));
      setSelectedCaseId(null);
      setDetail(null);
      setDetailRuns([]);
      await reloadCases();
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  // Live run trigger; `envIdOverride` re-runs a replayed run on its original
  // env (T13 re-run button) instead of the currently selected one.
  const triggerRun = async (envIdOverride?: string) => {
    const targetEnvId = envIdOverride ?? selectedEnvId;
    if (!detail || !projectId || !targetEnvId) return;
    setRunBusy(true);
    setRunResult(null);
    setRunFinal(null);
    setRunEvents([]);
    setReplayRun(null);
    setReplayDetail(null);
    setRunEnvId(targetEnvId);
    setRunOpen(true);
    // Subscribe before invoking so the stream's early events are not missed;
    // events are filtered to the run this trigger started.
    let activeRunId: string | null = null;
    const unlisten = await listen<RunEvent>('run-event', (e) => {
      if (!activeRunId) activeRunId = e.payload.runId;
      if (e.payload.runId === activeRunId) {
        setRunEvents((prev) => [...prev, e.payload]);
      }
    });
    try {
      const result = await invokeRunCase(projectId, targetEnvId, detail.id);
      setRunResult(result);
      const runList = await invokeListRuns(projectId, { caseId: detail.id });
      setDetailRuns(sortRunsDesc(runList));
      setRuns(await invokeListRuns(projectId));
      setRunFinal(sortRunsDesc(runList).find((r) => r.id === result.runId) ?? null);
    } catch (err) {
      onToast(String(err), true);
      setRunOpen(false);
    } finally {
      setRunBusy(false);
      unlisten();
    }
  };

  // Replay a finished run through all three layers (T13): session video,
  // screenshot timeline and the recorded agent transcript.
  const openReplay = async (run: Run) => {
    const ticket = ++replaySeq.current;
    setRunOpen(false);
    setRunEvents([]);
    setRunResult(null);
    setReplayRun(run);
    setReplayDetail(null);
    try {
      const fetched = await invokeGetRun(run.id);
      if (ticket !== replaySeq.current) return;
      setReplayDetail(fetched);
    } catch (err) {
      if (ticket !== replaySeq.current) return;
      onToast(String(err), true);
      setReplayRun(null);
    }
  };

  // ── batch execution (list multi-select) ──────────────────────────────
  const runnableIds = cases
    .filter((c) => c.status === CASE_STATUS.APPROVED)
    .map((c) => c.id);
  const selectedRunnableIds = runnableIds.filter((id) => selectedIds.has(id));
  const allRunnableSelected =
    runnableIds.length > 0 && selectedRunnableIds.length === runnableIds.length;

  useEffect(() => {
    if (headCheckRef.current) {
      headCheckRef.current.indeterminate = selectedIds.size > 0 && !allRunnableSelected;
    }
  }, [selectedIds, allRunnableSelected]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(allRunnableSelected ? new Set() : new Set(runnableIds));
  };

  // Cancel a run that started after the user hit Stop. Stop may land before
  // the child run registers its kernel controller (the startRun -> kernel.run
  // window reports FAILED_PRECONDITION), so retry once shortly after.
  const cancelQueuedRun = (runId: string) => {
    const attempt = (last: boolean) => {
      void invokeControlRun('cancel', runId).catch(() => {
        if (!last) setTimeout(() => attempt(true), 400);
      });
    };
    attempt(false);
  };

  const handleBatchEvent = (ev: BatchRunEvent) => {
    if (ev.kind === 'started' && ev.caseId && ev.runId) {
      const caseId = ev.caseId;
      const runId = ev.runId;
      runToCaseRef.current.set(runId, caseId);
      setBatchRuns((prev) => ({
        ...prev,
        [caseId]: { runId, status: RUN_STATUS.RUNNING, reason: '', events: [] },
      }));
      // Stopping: a queued case that only starts now is cancelled immediately.
      if (stoppingRef.current) cancelQueuedRun(runId);
    } else if (ev.kind === 'event' && ev.event) {
      const child = ev.event;
      const caseId = runToCaseRef.current.get(child.runId);
      if (!caseId) return;
      setBatchRuns((prev) => {
        const cur = prev[caseId];
        if (!cur) return prev;
        const status =
          child.kind === 'runStatus' && child.status !== undefined ? child.status : cur.status;
        return { ...prev, [caseId]: { ...cur, status, events: [...cur.events, child] } };
      });
      // Mirror into the open detail's live panel when it is this case.
      if (selectedCaseIdRef.current === caseId && batchEnvRef.current) {
        setRunEvents((prev) => [...prev, child]);
      }
    } else if (ev.kind === 'finished' && ev.caseId) {
      const caseId = ev.caseId;
      setBatchRuns((prev) => {
        const cur = prev[caseId];
        if (!cur) return prev;
        return {
          ...prev,
          [caseId]: { ...cur, status: ev.status ?? RUN_STATUS.FAILED, reason: ev.reason ?? '' },
        };
      });
      if (selectedCaseIdRef.current === caseId) setRunBusy(false);
    }
  };

  const triggerBatch = async () => {
    if (!projectId || !selectedEnvId || selectedRunnableIds.length === 0 || batchActive) return;
    setBatchActive(true);
    setBatchStopping(false);
    setBatchSummary(null);
    setBatchRuns({});
    runToCaseRef.current = new Map();
    batchEnvRef.current = selectedEnvId;
    stoppingRef.current = false;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<BatchRunEvent>('batch-run-event', (e) => handleBatchEvent(e.payload));
      const summary = await invokeBatchRunCases(
        projectId,
        selectedEnvId,
        selectedRunnableIds,
        batchConcurrency,
      );
      setBatchSummary(summary);
    } catch (err) {
      onToast(String(err), true);
    } finally {
      unlisten?.();
      stoppingRef.current = false;
      setBatchActive(false);
      setBatchStopping(false);
      setSelectedIds(new Set());
      // Drop the transient per-case batch state: the refreshed run list below
      // carries the final results (health / last-run columns).
      setBatchRuns({});
      // Refresh so health / last-run / count columns reflect the new runs.
      try {
        const [caseList, runList] = await Promise.all([
          invokeListCases(projectId),
          invokeListRuns(projectId),
        ]);
        setCases(caseList);
        setRuns(runList);
        onCountChange(caseList.length);
      } catch (err) {
        onToast(String(err), true);
      }
      if (selectedCaseIdRef.current) void openCase(selectedCaseIdRef.current);
    }
  };

  const stopBatch = async () => {
    if (!batchActive) return;
    // Mark the batch as stopping first: queued cases that start afterwards are
    // cancelled on their `started` event (the server keeps scheduling them).
    stoppingRef.current = true;
    setBatchStopping(true);
    const runIds = Object.values(batchRunsRef.current)
      .filter((state) => isRunActive(state.status))
      .map((state) => state.runId);
    await Promise.all(
      runIds.map((runId) => invokeControlRun('cancel', runId).catch(() => undefined)),
    );
  };

  // Batch bar: rendered in both the list and the detail view, so a batch can
  // still be stopped (and its tally seen) while a case is open mid-batch.
  const batchBar = (selectedIds.size > 0 || batchActive || batchSummary) && (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '10px 16px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        marginBottom: 12,
      }}
    >
      {selectedRunnableIds.length > 0 && (
        <span className="mono">
          {t('cases.batchSelected', { n: selectedRunnableIds.length })}
        </span>
      )}
      {envs.length > 0 ? (
        <Select
          ariaLabel={t('cases.runEnv')}
          value={selectedEnvId}
          placeholder={t('cases.pickEnv')}
          options={envs.map((e) => ({ value: e.id, label: e.name }))}
          onChange={(v) => onSelectEnv(v || null)}
        />
      ) : (
        <button className="btn sm" onClick={onOpenEnvs}>
          {t('cases.pickEnv')}
        </button>
      )}
      <span className="dim" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {t('cases.batchConcurrency')}
        <Select
          ariaLabel={t('cases.batchConcurrency')}
          value={String(batchConcurrency)}
          options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => setBatchConcurrency(Number(v) || 2)}
        />
      </span>
      {!batchActive ? (
        <button
          className="btn w sm"
          disabled={!selectedEnvId || selectedRunnableIds.length === 0}
          onClick={() => void triggerBatch()}
        >
          ▶ {t('cases.batchRun', { n: selectedRunnableIds.length })}
        </button>
      ) : (
        <button
          className="btn ghost sm"
          disabled={batchStopping}
          onClick={() => void stopBatch()}
        >
          ■ {t('cases.batchStop')}
        </button>
      )}
      {batchSummary && !batchActive && (
        <span className="dim mono">
          {t('cases.batchSummary', {
            pass: batchSummary.passed,
            fail: batchSummary.failed,
            cancel: batchSummary.cancelled,
          })}
        </span>
      )}
    </div>
  );

  const lastRun = selectedCaseId ? detailRuns[0] : null;

  if (!projectId) {
    return (
      <div className="page-inner">
        <div className="ph">
          <h1>{t('cases.title')}</h1>
        </div>
        <p className="hint">{t('common.selectProjectFirst')}</p>
      </div>
    );
  }

  return (
    <div className="page-inner">
      {!selectedCaseId ? (
        <>
          <div className="ph">
            <div>
              <h1>
                {t('cases.title')} <span className="pill">{cases.length}</span>
              </h1>
            </div>
            <div className="btns">
              <button className="btn w" onClick={() => { setEditing(null); setFormOpen(true); }}>
                ＋ {t('cases.new')}
              </button>
            </div>
          </div>
          {batchBar}
          <section className="sec">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: '36px' }}>
                    <input
                      ref={headCheckRef}
                      type="checkbox"
                      aria-label={t('cases.selectAll')}
                      checked={allRunnableSelected}
                      disabled={runnableIds.length === 0}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>{t('cases.colCase')}</th>
                  <th style={{ width: '14%' }}>{t('cases.colStatus')}</th>
                  <th className="col-3" style={{ width: '18%' }}>{t('cases.colCreator')}</th>
                  <th className="col-2" style={{ width: '16%' }}>{t('cases.colHealth')}</th>
                  <th className="col-2" style={{ width: '16%' }}>{t('cases.colLastRun')}</th>
                  <th className="num col-3" style={{ width: '8%' }}>{t('cases.colRuns')}</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((kase) => {
                  const lr = lastRunOf(runs, kase.id);
                  const caseRuns = runs.filter((r) => r.caseId === kase.id);
                  const batchState = batchRuns[kase.id];
                  return (
                    <tr key={kase.id} className="clickable" onClick={() => void openCase(kase.id)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={kase.title}
                          checked={selectedIds.has(kase.id)}
                          disabled={kase.status !== CASE_STATUS.APPROVED}
                          onChange={() => toggleSelect(kase.id)}
                        />
                      </td>
                      <td className="mono case-title">{kase.title}</td>
                      <td>
                        <CaseStatusBadge status={kase.status} />
                      </td>
                      <td className="dim col-3">{creatorLabel(kase, t)}</td>
                      <td className="col-2">
                        <HealthStrip results={sortRunsDesc(caseRuns)} />
                      </td>
                      <td className="col-2 ellip">
                        {batchState ? (
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                            <RunStatusTag status={batchState.status} />
                            {isRunActive(batchState.status) && (
                              <span className="dim num">{t('cases.batchLive')}</span>
                            )}
                          </span>
                        ) : lr ? (
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', maxWidth: '100%', minWidth: 0 }}>
                            <RunStatusTag status={lr.status} />
                            <span className="dim num">{formatTime(lr.startedAt, t)}</span>
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className="num col-3">{caseRuns.length || '—'}</td>
                    </tr>
                  );
                })}
                {cases.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">{t('cases.empty')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <>
          <div className="ph">
            <div>
              <h1 className="mono" style={{ fontSize: 20 }}>{detail?.title ?? '…'}</h1>
              <div className="path">
                {detail && <CaseStatusBadge status={detail.status} />}
              </div>
            </div>
            <div className="btns">
              {detail && caseEditableFor(detail.status) && (
                <button className="btn sm" onClick={() => { setEditing(detail); setFormOpen(true); }}>
                  {t('common.edit')}
                </button>
              )}
              {detail && (
                <button className="btn ghost sm" disabled={busy} onClick={() => void deleteCurrentCase()}>
                  {t('common.delete')}
                </button>
              )}
              <button className="btn ghost sm" onClick={() => setSelectedCaseId(null)}>
                ← {t('common.back')}
              </button>
            </div>
          </div>

          {batchBar}

          {detail && (
            <>
              {runOpen && (
                <RunPanel
                  caseTitle={detail.title}
                  envName={envs.find((e) => e.id === runEnvId)?.name ?? null}
                  events={runEvents}
                  running={runBusy}
                  result={runResult}
                  finalRun={runFinal}
                  onClose={() => setRunOpen(false)}
                  onToast={onToast}
                />
              )}
              {replayRun && (
                <RunPanel
                  replay
                  caseTitle={detail.title}
                  envName={envs.find((e) => e.id === replayRun.envId)?.name ?? null}
                  runId={replayRun.id}
                  events={replayDetail?.events ?? []}
                  running={false}
                  result={{
                    runId: replayRun.id,
                    status: replayRun.status,
                    failReason: replayRun.failReason,
                    verdict: replayRun.verdict ?? null,
                  }}
                  finalRun={replayRun}
                  artifacts={replayDetail?.artifacts ?? []}
                  onRerun={
                    detail.status === CASE_STATUS.APPROVED && !runBusy
                      ? () => void triggerRun(replayRun.envId)
                      : undefined
                  }
                  onClose={() => {
                    setReplayRun(null);
                    setReplayDetail(null);
                  }}
                  onToast={onToast}
                />
              )}
              <div className="grid2">
                <div>
                  <section className="sec">
                    <div className="shead">
                      <h2>{t('cases.info')}</h2>
                    </div>
                    <div className="kv">
                      <div className="k">{t('cases.goal')}</div>
                      <div className="v">{detail.goal}</div>
                      <div className="k">{t('cases.sourcePrd')}</div>
                      <div className="v mono">{detail.sourcePrdRef || '—'}</div>
                      <div className="k">{t('cases.creator')}</div>
                      <div className="v">{creatorLabel(detail, t)}</div>
                      <div className="k">{t('cases.version')}</div>
                      <div className="v num">v{detail.version}</div>
                      <div className="k">{t('cases.updatedAt')}</div>
                      <div className="v dim">{formatDateTime(detail.updatedAt)}</div>
                    </div>
                  </section>

                  <section className="sec">
                    <div className="shead">
                      <h2>{t('cases.alignments')}</h2>
                      <span className="n">{detail.alignments.length}</span>
                    </div>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>{t('cases.evApiPath')}</th>
                          <th className="col-2" style={{ width: '34%' }}>{t('cases.evUiAnchor')}</th>
                          <th style={{ width: '40%' }}>{t('cases.colRule')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.alignments.map((a, i) => (
                          <tr key={i}>
                            <td className="mono ellip">{a.apiPath}</td>
                            <td className="dim col-2 ellip">{a.uiAnchor}</td>
                            <td className="dim" style={{ whiteSpace: 'normal' }}>{a.rule}</td>
                          </tr>
                        ))}
                        {detail.alignments.length === 0 && (
                          <tr>
                            <td colSpan={3} className="empty">{t('cases.noAlignments')}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </section>

                  <section className="sec">
                    <div className="shead">
                      <h2>{t('cases.runHistory')}</h2>
                      <span className="n">{detailRuns.length}</span>
                    </div>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: '18%' }}>{t('runs.colTime')}</th>
                          <th className="col-2" style={{ width: '14%' }}>{t('runs.colEnv')}</th>
                          <th style={{ width: '18%' }}>{t('runs.colResult')}</th>
                          <th className="num col-2" style={{ width: '14%' }}>{t('runs.colDuration')}</th>
                          <th className="num col-3" style={{ width: '12%' }}>{t('runs.colTokens')}</th>
                          <th style={{ width: '24%' }}>{t('runs.colReplay')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailRuns.map((r) => {
                          const finished =
                            r.status === RUN_STATUS.PASSED ||
                            r.status === RUN_STATUS.FAILED ||
                            r.status === RUN_STATUS.CANCELLED;
                          return (
                            <tr key={r.id}>
                              <td className="dim num">{formatDateTime(r.startedAt)}</td>
                              <td className="dim col-2 ellip">{envs.find((e) => e.id === r.envId)?.name ?? r.envId.slice(0, 8)}</td>
                              <td>
                                <RunStatusTag status={r.status} />
                              </td>
                              <td className="num col-2">{formatDuration(r.durationMs)}</td>
                              <td className="num col-3">{r.tokenCost ? `${r.tokenCost}` : '—'}</td>
                              <td>
                                {finished ? (
                                  <button className="btn ghost sm" onClick={() => void openReplay(r)}>
                                    ▶ {t('runs.replay')}
                                  </button>
                                ) : (
                                  <span className="dim">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {detailRuns.length === 0 && (
                          <tr>
                            <td colSpan={6} className="empty">{t('cases.noRuns')}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </section>
                </div>

                <aside style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                  <div className="panelbox">
                    <div className="panelh">
                      <span>{t('cases.review')}</span>
                      <span className="mono">{t(caseStatusKey(detail.status))}</span>
                    </div>
                    <div style={{ padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {reviewActionsFor(detail.status).map((action) => (
                        <button
                          key={action}
                          className={action === REVIEW_ACTION.APPROVE ? 'btn w sm' : 'btn sm'}
                          disabled={busy}
                          onClick={() => void applyReview(action)}
                        >
                          {t(
                            `cases.reviewAction.${action === REVIEW_ACTION.APPROVE ? 'approve' : action === REVIEW_ACTION.REJECT ? 'reject' : 'disable'}`,
                          )}
                        </button>
                      ))}
                      {reviewActionsFor(detail.status).length === 0 && (
                        <span className="hint">{t('cases.noReviewActions')}</span>
                      )}
                    </div>
                  </div>

                  <div className="panelbox">
                    <div className="panelh">
                      <span>{t('cases.runTitle')}</span>
                    </div>
                    <div style={{ padding: '12px 16px' }}>
                      <div className="kv" style={{ gridTemplateColumns: '70px 1fr', marginBottom: 12 }}>
                        <div className="k">{t('cases.runEnv')}</div>
                        <div className="v">
                          {envs.length > 0 ? (
                            <Select
                              ariaLabel={t('cases.runEnv')}
                              value={selectedEnvId}
                              placeholder={t('cases.pickEnv')}
                              options={envs.map((e) => ({
                                value: e.id,
                                label: e.name,
                              }))}
                              onChange={(v) => onSelectEnv(v || null)}
                            />
                          ) : (
                            <button className="btn sm" onClick={onOpenEnvs}>
                              {t('cases.pickEnv')}
                            </button>
                          )}
                        </div>
                      </div>
                      <button
                        className="btn w"
                        style={{ width: '100%', justifyContent: 'center' }}
                        disabled={detail.status !== CASE_STATUS.APPROVED || !selectedEnvId || runBusy}
                        onClick={() => void triggerRun()}
                      >
                        {runBusy ? t('cases.running') : `▶ ${t('cases.runNow')}`}
                      </button>
                      {detail.status !== CASE_STATUS.APPROVED && (
                        <div className="hint" style={{ marginTop: 8 }}>
                          {t('cases.onlyApproved')}
                        </div>
                      )}
                    </div>
                  </div>

                  {lastRun && (
                    <div className="panelbox">
                      <div className="panelh">
                        <span>{t('cases.lastRun')}</span>
                        <span title={lastRun.id}>
                          {t('common.runId')} <b className="mono">#{lastRun.id.slice(0, 8)}</b>
                        </span>
                      </div>
                      <div className="mono-block">
                        <div className="t">
                          {t(runStatusKey(lastRun.status))}
                          {lastRun.failReason ? ` · ${lastRun.failReason}` : ''}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="panelbox">
                    <div className="panelh">
                      <span>{t('cases.changelog')}</span>
                      <span className="mono">{detail.changelog.length}</span>
                    </div>
                    <div className="mono-block" style={{ paddingTop: 6, paddingBottom: 10 }}>
                      {detail.changelog
                        .slice()
                        .reverse()
                        .map((e) => (
                          <div key={e.version}>
                            <span style={{ color: 'var(--w)' }}>v{e.version}</span>{' '}
                            <span style={{ color: 'var(--faint)' }}>
                              {e.author} · {formatDateTime(e.changedAt)}
                            </span>
                            <br />
                            <span style={{ color: 'var(--muted)' }}>{e.comment}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                </aside>
              </div>
            </>
          )}
        </>
      )}
      {formOpen && (
        <CaseFormModal
          projectId={projectId}
          kase={editing}
          onSaved={(saved) => void onCaseSaved(saved)}
          onClose={() => setFormOpen(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

export default CasesView;
