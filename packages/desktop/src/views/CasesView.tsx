// Cases view: case list (creator/status/last-run) + case detail with review
// actions, env strip, run history, and the minimal run trigger (T11).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Case, Env, Run, Verdict } from '@hpath/contract';
import {
  invokeGetCase,
  invokeListCases,
  invokeListRuns,
  invokeReviewCase,
  invokeRunCase,
  type RunResult,
} from '../lib/ipc';
import {
  CASE_STATUS,
  REVIEW_ACTION,
  RUN_STATUS,
  VERDICT_STATUS,
  caseStatusKey,
  formatDateTime,
  formatDuration,
  formatTime,
  reviewActionsFor,
  runStatusKey,
  sortRunsDesc,
} from '../lib/status';
import { CaseStatusBadge, RunStatusTag } from '../components/Ui';

type CasesViewProps = {
  appliedServerAddr: string;
  projectId: string | null;
  envs: Env[];
  selectedEnvId: string | null;
  refreshKey: number;
  onToast: (text: string, error?: boolean) => void;
  onCountChange: (count: number) => void;
  onOpenEnvs: () => void;
};

function creatorLabel(kase: Case, t: (key: string) => string): string {
  if (!kase.creator) return '—';
  if (kase.creator.type === 2) return `${t('cases.creatorAgent')} · ${kase.creator.name}`;
  return kase.creator.name || t('cases.creatorHuman');
}

function lastRunOf(runs: Run[], caseId: string): Run | undefined {
  return runs
    .filter((r) => r.caseId === caseId && (r.status === RUN_STATUS.PASSED || r.status === RUN_STATUS.FAILED))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
}

function VerdictPanel({ verdict }: { verdict: Verdict }) {
  const { t } = useTranslation();
  const key =
    verdict.status === VERDICT_STATUS.PASSED
      ? 'status.verdictPassed'
      : verdict.status === VERDICT_STATUS.FAILED
        ? 'status.verdictFailed'
        : 'status.verdictInconclusive';
  return (
    <div>
      <div className="panelh">
        <span>{t('cases.verdict')}</span>
        <b>{t(key)}</b>
      </div>
      <div className="mono-block">
        <div className="t">{verdict.summary}</div>
      </div>
      {verdict.evidence.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('cases.evApiPath')}</th>
              <th>{t('cases.evApiObserved')}</th>
              <th>{t('cases.evUiAnchor')}</th>
              <th>{t('cases.evUiObserved')}</th>
              <th>{t('cases.evMatch')}</th>
            </tr>
          </thead>
          <tbody>
            {verdict.evidence.map((e, i) => (
              <tr key={i}>
                <td className="mono">{e.apiPath}</td>
                <td className="mono dim" style={{ whiteSpace: 'normal' }}>{e.apiObserved}</td>
                <td className="dim">{e.uiAnchor}</td>
                <td className="mono dim" style={{ whiteSpace: 'normal' }}>{e.uiObserved}</td>
                <td>
                  <span className={e.match ? 'tag pass' : 'tag fail'}>
                    <i />
                    {e.match ? 'MATCH' : 'MISMATCH'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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

  const selectedEnv = envs.find((e) => e.id === selectedEnvId) ?? null;

  useEffect(() => {
    setSelectedCaseId(null);
    setDetail(null);
    setDetailRuns([]);
    setRunResult(null);
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
      setSelectedCaseId(caseId);
      setRunResult(null);
      setBusy(true);
      try {
        const [caseDetail, runList] = await Promise.all([
          invokeGetCase(caseId),
          invokeListRuns(projectId ?? '', { caseId }),
        ]);
        setDetail(caseDetail);
        setDetailRuns(sortRunsDesc(runList));
      } catch (err) {
        onToast(String(err), true);
      } finally {
        setBusy(false);
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

  const triggerRun = async () => {
    if (!detail || !projectId || !selectedEnvId) return;
    setRunBusy(true);
    setRunResult(null);
    try {
      const result = await invokeRunCase(projectId, selectedEnvId, detail.id);
      setRunResult(result);
      const runList = await invokeListRuns(projectId, { caseId: detail.id });
      setDetailRuns(sortRunsDesc(runList));
      setRuns(await invokeListRuns(projectId));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setRunBusy(false);
    }
  };

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
                {t('cases.title')} <span className="pill">{t('app.mock')}</span>
              </h1>
              <div className="path">{t('cases.subtitle')}</div>
            </div>
          </div>
          <section className="sec">
            <table>
              <thead>
                <tr>
                  <th>{t('cases.colCase')}</th>
                  <th>{t('cases.colStatus')}</th>
                  <th>{t('cases.colCreator')}</th>
                  <th>{t('cases.colLastRun')}</th>
                  <th className="num">{t('cases.colRuns')}</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((kase) => {
                  const lr = lastRunOf(runs, kase.id);
                  const caseRunCount = runs.filter((r) => r.caseId === kase.id).length;
                  return (
                    <tr key={kase.id} className="clickable" onClick={() => void openCase(kase.id)}>
                      <td className="mono">{kase.title}</td>
                      <td>
                        <CaseStatusBadge status={kase.status} />
                      </td>
                      <td className="dim">{creatorLabel(kase, t)}</td>
                      <td>
                        {lr ? (
                          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                            <RunStatusTag status={lr.status} />
                            <span className="dim num">{formatTime(lr.startedAt, t)}</span>
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className="num">{caseRunCount || '—'}</td>
                    </tr>
                  );
                })}
                {cases.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty">{t('cases.empty')}</td>
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
              <button className="btn ghost" onClick={() => setSelectedCaseId(null)}>
                ← {t('common.back')}
              </button>
            </div>
          </div>

          {detail && (
            <>
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
                    <table>
                      <thead>
                        <tr>
                          <th>{t('cases.evApiPath')}</th>
                          <th>{t('cases.evUiAnchor')}</th>
                          <th>{t('cases.colRule')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.alignments.map((a, i) => (
                          <tr key={i}>
                            <td className="mono">{a.apiPath}</td>
                            <td className="dim">{a.uiAnchor}</td>
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
                    <table>
                      <thead>
                        <tr>
                          <th>{t('runs.colTime')}</th>
                          <th>{t('runs.colEnv')}</th>
                          <th>{t('runs.colResult')}</th>
                          <th className="num">{t('runs.colDuration')}</th>
                          <th className="num">{t('runs.colTokens')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailRuns.map((r) => (
                          <tr key={r.id}>
                            <td className="dim num">{formatDateTime(r.startedAt)}</td>
                            <td className="dim">{envs.find((e) => e.id === r.envId)?.name ?? r.envId.slice(0, 8)}</td>
                            <td>
                              <RunStatusTag status={r.status} />
                            </td>
                            <td className="num">{formatDuration(r.durationMs)}</td>
                            <td className="num">{r.tokenCost ? `${r.tokenCost}` : '—'}</td>
                          </tr>
                        ))}
                        {detailRuns.length === 0 && (
                          <tr>
                            <td colSpan={5} className="empty">{t('cases.noRuns')}</td>
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
                          {selectedEnv ? (
                            <span className="badge">{selectedEnv.name}</span>
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
                        <b className="mono">{lastRun.id.slice(0, 8)}</b>
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

      {runResult && (
        <div className="overlay" onClick={() => setRunResult(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {t('cases.runResult')} · <span className="mono">{runResult.runId.slice(0, 8)}</span>
            </h3>
            <div className="panelbox" style={{ marginBottom: 16 }}>
              <div className="panelh">
                <span>{t('cases.runStatus')}</span>
                <RunStatusTag status={runResult.status} />
              </div>
              {runResult.verdict ? (
                <VerdictPanel verdict={runResult.verdict} />
              ) : (
                <div className="mono-block">
                  {runResult.failReason || t('cases.noVerdict')}
                </div>
              )}
            </div>
            <div className="mfoot">
              <button className="btn" onClick={() => setRunResult(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CasesView;
