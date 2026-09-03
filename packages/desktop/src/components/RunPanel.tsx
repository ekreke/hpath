// Run panel: live mode (T12) renders the event stream forwarded by the Rust
// side on the `run-event` channel while run_case is in flight; replay mode
// (T13) renders a finished run fetched via get_run — inline session video,
// screenshot timeline, agent transcript, trace.zip download + one-click
// `playwright show-trace`, and a re-run button.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Artifact, Run } from '@hpath/contract';
import { ArtifactKind } from '@hpath/contract';
import {
  invokeDownloadArtifact,
  invokeSaveArtifact,
  invokeShowTrace,
  type ArtifactProgress,
  type RunEvent,
  type RunResult,
} from '../lib/ipc';
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
  // Replay mode (T13): artifact index of the finished run + re-run trigger.
  replay?: boolean;
  artifacts?: Artifact[];
  runId?: string;
  onRerun?: () => void;
  onClose: () => void;
  onToast: (text: string, error?: boolean) => void;
};

// Base64 data URLs per artifact, shared across panel openings. Capped so a
// long session cannot retain every screenshot of every run forever.
const CACHE_LIMIT = 100;
const thumbnailCache = new Map<string, string>();
const videoCache = new Map<string, string>();

function cachePut(cache: Map<string, string>, id: string, url: string) {
  if (!cache.has(id) && cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, url);
}

// Progress-aware fetch of an artifact's bytes as a data URL: callers may
// surface a per-chunk progress tick through the IPC progress channel, and a
// failed download becomes an error state the caller can render with a retry.
function useArtifactDataUrl(
  artifact: Artifact | null,
  mime: string,
  cache: Map<string, string>,
  onProgress?: (p: ArtifactProgress) => void,
): { src: string | null; error: string | null; retry: () => void } {
  const [src, setSrc] = useState<string | null>(
    () => (artifact ? cache.get(artifact.id) ?? null : null),
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!artifact || src) return;
    let cancelled = false;
    setError(null);
    invokeDownloadArtifact(artifact.id, onProgress)
      .then((b64) => {
        const url = `data:${mime};base64,${b64}`;
        cachePut(cache, artifact.id, url);
        if (!cancelled) setSrc(url);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact?.id, src, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { src, error, retry };
}

function Screenshot({
  artifactId,
  caption,
  sizeBytes,
  onZoom,
  onToast,
}: {
  artifactId: string;
  caption: string;
  // Total size when known (timeline artifacts): enables a download percent in
  // the placeholder. Transcript-only screenshots have no artifact entity.
  sizeBytes?: number;
  onZoom: (src: string) => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const cached = thumbnailCache.get(artifactId) ?? null;
  const [src, setSrc] = useState<string | null>(cached);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (src) return;
    let cancelled = false;
    invokeDownloadArtifact(artifactId, (p) => {
      if (sizeBytes) {
        setPct(Math.min(100, Math.round((p.bytesReceived / Math.max(sizeBytes, 1)) * 100)));
      }
    })
      .then((b64) => {
        const url = `data:image/png;base64,${b64}`;
        cachePut(thumbnailCache, artifactId, url);
        if (!cancelled) setSrc(url);
      })
      .catch((err) => {
        if (!cancelled) onToast(String(err), true);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId, src, onToast, sizeBytes]);

  if (!src) {
    const label = caption || t('runPanel.loadingShot');
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
        {label}
        {pct > 0 && pct < 100 ? ` ${pct}%` : ''}
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

// Inline session video of a replayed run (T13): the mock server produces a
// tiny real WebM, fetched through the progress-reporting download IPC.
function SessionVideo({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation();
  const [pct, setPct] = useState(0);
  const { src, error, retry } = useArtifactDataUrl(artifact, 'video/webm', videoCache, (p) =>
    setPct(Math.min(100, Math.round((p.bytesReceived / Math.max(artifact.sizeBytes, 1)) * 100))),
  );

  if (error) {
    return (
      <div className="mono dim" style={{ padding: '12px 16px', fontSize: 12 }}>
        {t('runPanel.videoFailed')}{' '}
        <button className="btn ghost sm" onClick={retry}>
          {t('runPanel.retry')}
        </button>
      </div>
    );
  }
  if (!src) {
    return (
      <div className="mono dim" style={{ padding: '12px 16px', fontSize: 12 }}>
        {t('runPanel.videoLoading', { pct })}
      </div>
    );
  }
  return (
    <div style={{ padding: '12px 16px' }}>
      <video
        controls
        src={src}
        style={{ width: 320, maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)', background: '#000' }}
      />
    </div>
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
  replay,
  artifacts,
  runId,
  onRerun,
  onClose,
  onToast,
}: RunPanelProps) {
  const { t } = useTranslation();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const steps = events.filter((e) => e.kind === 'toolStarted').length;

  // Replay material (T13): session video, screenshot timeline, trace.zip.
  const video = (artifacts ?? []).find((a) => a.kind === ArtifactKind.ARTIFACT_KIND_VIDEO) ?? null;
  const trace = (artifacts ?? []).find((a) => a.kind === ArtifactKind.ARTIFACT_KIND_TRACE) ?? null;
  const shots = useMemo(
    () => (artifacts ?? []).filter((a) => a.kind === ArtifactKind.ARTIFACT_KIND_SCREENSHOT),
    [artifacts],
  );
  // Event captions carry friendlier labels than artifact keys.
  const shotCaptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const ev of events) {
      if (ev.kind === 'screenshot' && ev.artifactId && !map.has(ev.artifactId)) {
        map.set(ev.artifactId, ev.caption ?? '');
      }
    }
    return map;
  }, [events]);

  const saveTrace = async () => {
    if (!trace) return;
    try {
      const filename = `trace-${(runId ?? 'run').slice(0, 8)}.zip`;
      const path = await invokeSaveArtifact(trace.id, filename);
      onToast(t('runPanel.traceSaved', { path }));
    } catch (err) {
      onToast(String(err), true);
    }
  };

  const openTrace = async () => {
    if (!trace) return;
    try {
      await invokeShowTrace(trace.id, runId ?? '');
      onToast(t('runPanel.traceLaunching'));
    } catch (err) {
      onToast(String(err), true);
    }
  };

  useEffect(() => {
    if (!running) return;
    const started = Date.now() - elapsedMs;
    const timer = setInterval(() => setElapsedMs(Date.now() - started), 500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Follow the live feed; a replay transcript starts at the top.
  useEffect(() => {
    if (!running) return;
    const el = feedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [events.length, running]);

  const status = running ? RUN_STATUS.RUNNING : (result?.status ?? RUN_STATUS.PENDING);

  return (
    <section className="sec">
      <div className="shead">
        <h2>
          {t(replay ? 'runPanel.replayTitle' : 'runPanel.title')} · <span className="mono">{caseTitle}</span>
          {runId && <span className="mono dim" style={{ marginLeft: 8, fontSize: 12 }}>#{runId.slice(0, 8)}</span>}
          {envName && <span className="badge" style={{ marginLeft: 8 }}>{envName}</span>}
        </h2>
        <span className="more">
          {onRerun && (
            <button className="btn sm" style={{ marginRight: 8 }} onClick={onRerun}>
              ⟳ {t('runPanel.rerun')}
            </button>
          )}
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
          {!replay && (
            <span>
              {t('runPanel.elapsed')}: <b className="num">{formatDuration(elapsedMs)}</b>
            </span>
          )}
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

      {replay && video && <SessionVideo artifact={video} />}

      {replay && shots.length > 0 && (
        <div className="panelbox" style={{ marginTop: video ? 12 : 0 }}>
          <div className="panelh">
            <span>{t('runPanel.timeline')}</span>
            <span className="mono">{shots.length}</span>
          </div>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto', padding: '12px 16px' }}>
            {shots.map((shot) => (
              <Screenshot
                key={shot.id}
                artifactId={shot.id}
                caption={shotCaptions.get(shot.id) || shot.key.split('/').pop() || ''}
                sizeBytes={shot.sizeBytes}
                onZoom={setZoom}
                onToast={onToast}
              />
            ))}
          </div>
        </div>
      )}

      <div className="panelbox" style={{ marginTop: replay && (video || shots.length > 0) ? 12 : 0 }}>
        <div className="panelh">
          <span>{t(replay ? 'runPanel.transcript' : 'runPanel.events')}</span>
          <span className="mono">{events.length}</span>
        </div>
        <div className="log" ref={feedRef} style={{ maxHeight: 340, overflowY: 'auto' }}>
          {events.map((ev) => (
            <EventLine key={`${ev.runId}-${ev.seq}`} ev={ev} onZoom={setZoom} onToast={onToast} />
          ))}
          {events.length === 0 && (
            <div className="ln">
              <span className="tx" style={{ color: 'var(--faint2)' }}>
                {t(replay ? 'runPanel.loadingRun' : 'runPanel.empty')}
              </span>
            </div>
          )}
        </div>
      </div>

      {replay && trace && (
        <div className="panelbox" style={{ marginTop: 12 }}>
          <div className="panelh">
            <span>{t('runPanel.traceTitle')}</span>
            <span className="mono dim">{trace.key.split('/').pop()} · {trace.sizeBytes} B</span>
          </div>
          <div style={{ padding: '12px 16px', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn sm" onClick={() => void saveTrace()}>
              {t('runPanel.saveTrace')}
            </button>
            <button className="btn sm" onClick={() => void openTrace()}>
              {t('runPanel.showTrace')}
            </button>
            <span className="hint" style={{ margin: 0 }}>{t('runPanel.traceHint')}</span>
          </div>
        </div>
      )}

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
