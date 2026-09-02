// Live run panel (T12), embedded in the case detail view: renders the run
// event stream forwarded by the Rust side on the `run-event` channel while
// run_case is in flight — per-kind event feed with inline screenshot
// thumbnails, a steps/elapsed status bar, and the final verdict once the
// command resolves.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Run } from '@hpath/contract';
import { invokeDownloadArtifact, type RunEvent, type RunResult } from '../lib/ipc';
import { RUN_STATUS, formatDuration, runStatusKey } from '../lib/status';
import { RunStatusTag } from './Ui';
import VerdictPanel from './VerdictPanel';

type RunPanelProps = {
  caseTitle: string;
  envName: string | null;
  events: RunEvent[];
  running: boolean;
  result: RunResult | null;
  // Refreshed run entity after completion; carries duration/token cost.
  finalRun?: Run | null;
  onClose: () => void;
  onToast: (text: string, error?: boolean) => void;
};

// Base64 data URLs per artifact, shared across panel openings.
const thumbnailCache = new Map<string, string>();

function Screenshot({
  artifactId,
  caption,
  onZoom,
  onToast,
}: {
  artifactId: string;
  caption: string;
  onZoom: (src: string) => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null>(thumbnailCache.get(artifactId) ?? null);

  useEffect(() => {
    if (src) return;
    let cancelled = false;
    invokeDownloadArtifact(artifactId)
      .then((b64) => {
        const url = `data:image/png;base64,${b64}`;
        thumbnailCache.set(artifactId, url);
        if (!cancelled) setSrc(url);
      })
      .catch((err) => {
        if (!cancelled) onToast(String(err), true);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, src, onToast]);

  if (!src) {
    return (
      <div
        className="mono dim"
        style={{
          width: 220,
          height: 90,
          border: '1px dashed var(--line, #ccc)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
        }}
      >
        {caption || t('runPanel.loadingShot')}
      </div>
    );
  }
  return (
    <figure style={{ margin: 0, display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <img
        src={src}
        alt={caption}
        style={{ maxWidth: 260, maxHeight: 140, borderRadius: 8, cursor: 'zoom-in', border: '1px solid var(--line, #ccc)' }}
        onClick={() => onZoom(src)}
      />
      <figcaption className="dim" style={{ fontSize: 12 }}>{caption}</figcaption>
    </figure>
  );
}

function EventLine({
  ev,
  onZoom,
  onToast,
}: {
  ev: RunEvent;
  onZoom: (src: string) => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const ts = new Date(ev.timestamp);
  const time = Number.isNaN(ts.getTime()) ? '' : ts.toLocaleTimeString(i18n.language);
  const errorStyle = ev.kind === 'error' ? { color: 'var(--bad, #c0392b)' } : undefined;

  return (
    <div className="ln">
      {time && <span className="ts">{time}</span>}
      <span className="tx" style={errorStyle}>
        {ev.kind === 'agentThinking' && <><b>think</b> <i>{ev.text}</i></>}
        {ev.kind === 'agentText' && <><b>agent</b> {ev.text}</>}
        {ev.kind === 'toolStarted' && (
          <>
            <b>tool ▸</b> <span className="mono">{ev.tool}</span>
            {ev.argsJson && ev.argsJson !== '{}' && (
              <span className="mono dim"> {ev.argsJson}</span>
            )}
          </>
        )}
        {ev.kind === 'toolFinished' && (
          <>
            <b>tool ✓</b> <span className="mono">{ev.tool}</span>
            {' '}
            {ev.ok ? (
              <span className="dim">{ev.resultSummary}</span>
            ) : (
              <b>{t('runPanel.toolFailed')}</b>
            )}
          </>
        )}
        {ev.kind === 'screenshot' && ev.artifactId && (
          <Screenshot
            artifactId={ev.artifactId}
            caption={ev.caption ?? ''}
            onZoom={onZoom}
            onToast={onToast}
          />
        )}
        {ev.kind === 'requestRecord' && (
          <>
            <b>{ev.direction || 'http'}</b>{' '}
            <span className="mono">{ev.method}</span>{' '}
            <span className="mono">{ev.target}</span>
            {(ev.requestJson || ev.responseJson) && (
              <details style={{ marginTop: 4 }}>
                <summary className="dim" style={{ cursor: 'pointer', fontSize: 12 }}>
                  {t('runPanel.showJson')}
                </summary>
                {ev.requestJson && (
                  <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0' }}>
                    {ev.requestJson}
                  </pre>
                )}
                {ev.responseJson && (
                  <pre className="mono dim" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0' }}>
                    {ev.responseJson}
                  </pre>
                )}
              </details>
            )}
          </>
        )}
        {ev.kind === 'verdict' && ev.verdict && <><b>verdict</b> {ev.verdict.summary}</>}
        {ev.kind === 'error' && (
          <><b>error</b> <span className="mono">{ev.errorKind}</span>: {ev.errorMessage}</>
        )}
        {ev.kind === 'runStatus' && (
          <><b>status</b> {t(runStatusKey(ev.status ?? 0))}{ev.reason ? ` · ${ev.reason}` : ''}</>
        )}
      </span>
    </div>
  );
}

function RunPanel({
  caseTitle,
  envName,
  events,
  running,
  result,
  finalRun,
  onClose,
  onToast,
}: RunPanelProps) {
  const { t } = useTranslation();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const steps = events.filter((e) => e.kind === 'toolStarted').length;

  useEffect(() => {
    if (!running) return;
    const started = Date.now() - elapsedMs;
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [events.length]);

  const status = running ? RUN_STATUS.RUNNING : (result?.status ?? RUN_STATUS.PENDING);

  return (
    <section className="sec">
      <div className="shead">
        <h2>
          {t('runPanel.title')} · <span className="mono">{caseTitle}</span>
          {envName && <span className="badge" style={{ marginLeft: 8 }}>{envName}</span>}
        </h2>
        <span className="more">
          <button className="btn ghost sm" onClick={onClose}>
            {t('common.close')}
          </button>
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'center',
          padding: '8px 16px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          marginBottom: 12,
          fontSize: 13,
        }}
      >
          <RunStatusTag status={status} />
          <span>
            {t('runPanel.steps')}: <b className="num">{steps}</b>
          </span>
          <span>
            {t('runPanel.elapsed')}: <b className="num">{formatDuration(elapsedMs)}</b>
          </span>
          {!running && finalRun && (
            <>
              <span>
                {t('runPanel.duration')}: <b className="num">{formatDuration(finalRun.durationMs)}</b>
              </span>
              <span>
                {t('runPanel.tokens')}: <b className="num">{finalRun.tokenCost}</b>
              </span>
            </>
          )}
      </div>

      <div className="panelbox">
        <div className="panelh">
          <span>{t('runPanel.events')}</span>
          <span className="mono">{events.length}</span>
        </div>
        <div className="log" ref={feedRef} style={{ maxHeight: 340, overflowY: 'auto' }}>
          {events.map((ev) => (
            <EventLine key={`${ev.runId}-${ev.seq}`} ev={ev} onZoom={setZoom} onToast={onToast} />
          ))}
          {events.length === 0 && (
            <div className="ln">
              <span className="tx" style={{ color: 'var(--faint2)' }}>{t('runPanel.empty')}</span>
            </div>
          )}
        </div>
      </div>

      {result && (
        <div className="panelbox" style={{ marginTop: 12 }}>
          <div className="panelh">
            <span>{t('cases.runStatus')}</span>
            <RunStatusTag status={result.status} />
          </div>
          {result.verdict ? (
            <VerdictPanel verdict={result.verdict} />
          ) : (
            <div className="mono-block">
              {result.failReason || t('cases.noVerdict')}
            </div>
          )}
        </div>
      )}

      {zoom && (
        <div
          className="overlay"
          style={{ zIndex: 10 }}
          // Keep the panel open: without this the click bubbles to the root
          // overlay, whose onClose would dismiss the whole run panel.
          onClick={(e) => {
            e.stopPropagation();
            setZoom(null);
          }}
        >
          <img
            src={zoom}
            alt="screenshot"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 12, cursor: 'zoom-out' }}
          />
        </div>
      )}
    </section>
  );
}

export default RunPanel;
