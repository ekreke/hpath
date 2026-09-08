// Run panel: live mode (T12) renders the event stream forwarded by the Rust
// side on the `run-event` channel while run_case is in flight; replay mode
// (T13) renders a finished run fetched via get_run — inline session video,
// agent transcript, trace.zip download + one-click `playwright show-trace`,
// and a re-run button.
//
// Execution-history redesign: a dual-row mini timeline (model row = green
// activity spans, tools row = green tool spans + blue ticks for screenshots),
// a search toolbar and a merged step list. Color semantics: green = generic
// agent activity, blue = screenshots, red = errors.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Artifact, Run, Verdict } from '@hpath/contract';
import { ArtifactKind } from '@hpath/contract';
import {
  invokeControlRun,
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

// In-flight downloads, shared so concurrent consumers of the same artifact
// (live transcript + replay timeline render the same screenshot ids) issue
// one gRPC download instead of one per consumer.
const inflightArtifacts = new Map<string, Promise<string>>();

function cacheGetOrFetch(
  cache: Map<string, string>,
  id: string,
  mime: string,
  onProgress?: (p: ArtifactProgress) => void,
): Promise<string> {
  const cached = cache.get(id);
  if (cached) return Promise.resolve(cached);
  let inflight = inflightArtifacts.get(id);
  if (!inflight) {
    inflight = invokeDownloadArtifact(id, onProgress).then((b64) => {
      const url = `data:${mime};base64,${b64}`;
      cachePut(cache, id, url);
      return url;
    });
    inflightArtifacts.set(id, inflight);
    // A failed download must not poison later retries: drop it so the next
    // call (e.g. after the user clicks retry) downloads fresh.
    inflight.catch(() => inflightArtifacts.delete(id));
  }
  return inflight;
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
    cacheGetOrFetch(cache, artifact.id, mime, onProgress)
      .then((url) => {
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
  accent,
  onZoom,
  onToast,
}: {
  artifactId: string;
  caption: string;
  // Total size when known (timeline artifacts): enables a download percent in
  // the placeholder. Transcript-only screenshots have no artifact entity.
  sizeBytes?: number;
  // Border accent for the thumbnail frame; screenshots render blue.
  accent?: string;
  onZoom: (src: string) => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const frame = accent ?? 'var(--border2)';
  const cached = thumbnailCache.get(artifactId) ?? null;
  const [src, setSrc] = useState<string | null>(cached);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (src) return;
    let cancelled = false;
    cacheGetOrFetch(thumbnailCache, artifactId, 'image/png', (p) => {
      if (sizeBytes) {
        setPct(Math.min(100, Math.round((p.bytesReceived / Math.max(sizeBytes, 1)) * 100)));
      }
    })
      .then((url) => {
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
          border: `1px dashed ${frame}`,
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
        style={{ maxWidth: 260, maxHeight: 140, borderRadius: 8, cursor: 'zoom-in', border: `1px solid ${frame}` }}
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

// ── merged step model ────────────────────────────────────────────────────
// The raw event stream separates toolStarted/toolFinished; the step list
// merges each pair into one row (like the reference design) so per-call
// durations can be shown on the right. Color: green = default agent
// activity, blue = screenshots, red = errors.
type StepKind = 'think' | 'agent' | 'tool' | 'shot' | 'http' | 'verdict' | 'error' | 'status';
type StepColor = 'green' | 'blue' | 'red';

type Step = {
  key: string;
  seq: number;
  relMs: number;
  kind: StepKind;
  color: StepColor;
  // tool
  tool?: string;
  argsJson?: string;
  ok?: boolean;
  resultSummary?: string;
  durationMs?: number;
  running?: boolean;
  // shot
  artifactId?: string;
  caption?: string;
  // http
  direction?: string;
  method?: string;
  target?: string;
  requestJson?: string;
  responseJson?: string;
  // think / agent text
  text?: string;
  // verdict
  verdict?: Verdict | null;
  // error
  errorKind?: string;
  errorMessage?: string;
  // status
  status?: number;
  reason?: string;
};

const STEP_ICONS: Record<StepKind, string> = {
  think: '✻',
  agent: '❯',
  tool: '▸',
  shot: '▣',
  http: '⇄',
  verdict: '⚑',
  error: '✗',
  status: '●',
};

// Compact duration for step rows and the timeline axis: "0.0s" / "1.5s" /
// "3m11s" (mirrors the reference design's right-hand column).
function fmtDur(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  if (rs >= 60) return `${m + 1}m00s`;
  return `${m}m${String(rs).padStart(2, '0')}s`;
}

// Relative offset from run start as "+MM:SS".
function fmtRel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function relMs(t0: number, timestamp: string): number {
  const v = Date.parse(timestamp);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, v - t0);
}

function buildSteps(events: RunEvent[]): Step[] {
  const steps: Step[] = [];
  if (!events.length) return steps;
  const t0 = Date.parse(events[0].timestamp);
  const base0 = Number.isNaN(t0) ? 0 : t0;
  // Started-but-unfinished tool calls, queued per tool name so nested or
  // repeated same-tool calls pair in order.
  const pending = new Map<string, Step[]>();

  for (const ev of events) {
    const key = `${ev.runId}-${ev.seq}`;
    const rel = relMs(base0, ev.timestamp);
    switch (ev.kind) {
      case 'toolStarted': {
        const step: Step = {
          key, seq: ev.seq, relMs: rel, kind: 'tool', color: 'green',
          tool: ev.tool, argsJson: ev.argsJson, running: true,
        };
        steps.push(step);
        const q = pending.get(ev.tool ?? '') ?? [];
        q.push(step);
        pending.set(ev.tool ?? '', q);
        break;
      }
      case 'toolFinished': {
        const q = ev.tool ? pending.get(ev.tool) : undefined;
        const started = q?.shift();
        if (started) {
          if (q && q.length === 0) pending.delete(ev.tool ?? '');
          started.running = false;
          started.ok = ev.ok;
          started.resultSummary = ev.resultSummary;
          started.durationMs = Math.max(0, rel - started.relMs);
        } else {
          // Finish without a visible start (truncated stream): keep the row.
          steps.push({
            key, seq: ev.seq, relMs: rel, kind: 'tool', color: 'green',
            tool: ev.tool, ok: ev.ok, resultSummary: ev.resultSummary,
          });
        }
        break;
      }
      case 'screenshot':
        if (ev.artifactId) {
          steps.push({
            key, seq: ev.seq, relMs: rel, kind: 'shot', color: 'blue',
            artifactId: ev.artifactId, caption: ev.caption,
          });
        }
        break;
      case 'requestRecord':
        steps.push({
          key, seq: ev.seq, relMs: rel, kind: 'http', color: 'green',
          direction: ev.direction, method: ev.method, target: ev.target,
          requestJson: ev.requestJson, responseJson: ev.responseJson,
        });
        break;
      case 'agentThinking':
        steps.push({ key, seq: ev.seq, relMs: rel, kind: 'think', color: 'green', text: ev.text });
        break;
      case 'agentText':
        steps.push({ key, seq: ev.seq, relMs: rel, kind: 'agent', color: 'green', text: ev.text });
        break;
      case 'verdict':
        if (ev.verdict) {
          steps.push({ key, seq: ev.seq, relMs: rel, kind: 'verdict', color: 'green', verdict: ev.verdict });
        }
        break;
      case 'error':
        steps.push({
          key, seq: ev.seq, relMs: rel, kind: 'error', color: 'red',
          errorKind: ev.errorKind, errorMessage: ev.errorMessage,
        });
        break;
      case 'runStatus':
        steps.push({
          key, seq: ev.seq, relMs: rel, kind: 'status', color: 'green',
          status: ev.status, reason: ev.reason,
        });
        break;
    }
  }
  return steps;
}

// Lowercased haystack per step for the search toolbar.
function stepHaystack(s: Step): string {
  return [
    s.tool, s.argsJson, s.resultSummary, s.text, s.caption,
    s.method, s.target, s.direction, s.errorKind, s.errorMessage,
    s.verdict?.summary ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

// ── dual-row mini timeline ───────────────────────────────────────────────
// Model row: green spans where the agent generates (gaps between tool calls).
// Tools row: green spans per tool call, blue ticks at screenshot moments.
// Clicking a blue tick scrolls the step list to that screenshot row.
function RunTimelineBar({
  events,
  totalMs,
  onPickShot,
}: {
  events: RunEvent[];
  totalMs: number;
  onPickShot: (key: string) => void;
}) {
  const { t } = useTranslation();

  const tl = useMemo(() => {
    const model: Array<{ a: number; b: number }> = [];
    const tools: Array<{ a: number; b: number }> = [];
    const shots: Array<{ at: number; key: string; caption?: string }> = [];
    if (!events.length) return { model, tools, shots };
    const t0 = Date.parse(events[0].timestamp);
    const base0 = Number.isNaN(t0) ? 0 : t0;
    const pending = new Map<string, number[]>();
    let cursor = 0;
    const closeModel = (until: number) => {
      if (until > cursor) {
        model.push({ a: cursor, b: until });
        cursor = until;
      }
    };

    for (const ev of events) {
      const r = relMs(base0, ev.timestamp);
      if (ev.kind === 'toolStarted') {
        closeModel(r);
        const q = pending.get(ev.tool ?? '') ?? [];
        q.push(r);
        pending.set(ev.tool ?? '', q);
      } else if (ev.kind === 'toolFinished') {
        const q = ev.tool ? pending.get(ev.tool) : undefined;
        const start = q?.shift();
        if (start !== undefined) {
          tools.push({ a: start, b: Math.max(start + 1, r) });
          closeModel(r);
        }
      } else if (ev.kind === 'screenshot' && ev.artifactId) {
        shots.push({ at: r, key: `${ev.runId}-${ev.seq}`, caption: ev.caption });
      }
    }
    const end = Math.max(totalMs, cursor);
    // Tools still in flight (live mode): render as growing spans.
    for (const starts of pending.values()) {
      for (const a of starts) tools.push({ a, b: Math.max(a + 1, end) });
    }
    closeModel(end);
    return { model, tools, shots };
  }, [events, totalMs]);

  const total = Math.max(totalMs, 1);
  const pct = (v: number) => `${Math.min(100, (v / total) * 100)}%`;

  return (
    <div className="rt">
      <div className="rt-axis">
        <span>0s</span>
        <span>{fmtDur(total / 2)}</span>
        <span>{fmtDur(total)}</span>
      </div>
      <div className="rt-row">
        <span className="rt-label">{t('runPanel.rowModel')}</span>
        <div className="rt-track">
          {tl.model.map((s, i) => (
            <i key={i} className="rt-seg" style={{ left: pct(s.a), width: `${(Math.max(0, s.b - s.a) / total) * 100}%` }} />
          ))}
        </div>
      </div>
      <div className="rt-row">
        <span className="rt-label">{t('runPanel.rowTools')}</span>
        <div className="rt-track">
          {tl.tools.map((s, i) => (
            <i key={i} className="rt-seg" style={{ left: pct(s.a), width: `${(Math.max(0, s.b - s.a) / total) * 100}%` }} />
          ))}
          {tl.shots.map((s) => (
            <button
              key={s.key}
              type="button"
              className="rt-tick"
              style={{ left: pct(s.at) }}
              title={s.caption || undefined}
              onClick={() => onPickShot(s.key)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepRow({
  step,
  onZoom,
  onToast,
}: {
  step: Step;
  onZoom: (src: string) => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const { t } = useTranslation();
  const dur =
    step.durationMs !== undefined
      ? fmtDur(step.durationMs)
      : step.running
        ? '…'
        : '';

  return (
    <div id={`hstep-${step.key}`} className={`step ${step.color}`}>
      <span className="rel num">+{fmtRel(step.relMs)}</span>
      <span className="bar" />
      <span className="ic">{STEP_ICONS[step.kind]}</span>
      <span className="bd">
        {step.kind === 'think' && <span className="think">{step.text}</span>}
        {step.kind === 'agent' && <span>{step.text}</span>}
        {step.kind === 'tool' && (
          <>
            <span className="tn">{step.tool}</span>
            <span className="sum" title={step.argsJson || undefined}>
              {step.running ? (
                step.argsJson && step.argsJson !== '{}' ? step.argsJson : null
              ) : step.ok === false ? (
                <b>{t('runPanel.toolFailed')}</b>
              ) : (
                step.resultSummary || step.argsJson || ''
              )}
            </span>
          </>
        )}
        {step.kind === 'shot' && step.artifactId && (
          <Screenshot
            artifactId={step.artifactId}
            caption={step.caption ?? ''}
            accent="var(--hc-3)"
            onZoom={onZoom}
            onToast={onToast}
          />
        )}
        {step.kind === 'http' && (
          <>
            <span className="tn">{step.direction || 'http'}</span>
            <span className="mono">{step.method}</span> <span className="mono">{step.target}</span>
            {(step.requestJson || step.responseJson) && (
              <details style={{ marginTop: 4 }}>
                <summary className="dim" style={{ cursor: 'pointer', fontSize: 12 }}>
                  {t('runPanel.showJson')}
                </summary>
                {step.requestJson && (
                  <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0' }}>
                    {step.requestJson}
                  </pre>
                )}
                {step.responseJson && (
                  <pre className="mono dim" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0' }}>
                    {step.responseJson}
                  </pre>
                )}
              </details>
            )}
          </>
        )}
        {step.kind === 'verdict' && step.verdict && <><b>verdict</b> {step.verdict.summary}</>}
        {step.kind === 'error' && (
          <><b>error</b> <span className="mono">{step.errorKind}</span>: {step.errorMessage}</>
        )}
        {step.kind === 'status' && (
          <><b>status</b> {t(runStatusKey(step.status ?? 0))}{step.reason ? ` · ${step.reason}` : ''}</>
        )}
      </span>
      {dur && <span className="dur">{dur}</span>}
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
  const [query, setQuery] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);

  // Live lifecycle status: the latest run_status event in the stream wins
  // (RUNNING / PAUSED / terminal); falls back to RUNNING while the run is
  // in flight and to the settled result's status after completion.
  const liveStatus = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.kind === 'runStatus' && ev.status !== undefined) return ev.status;
    }
    return undefined;
  }, [events]);
  const status = running
    ? (liveStatus ?? RUN_STATUS.RUNNING)
    : (result?.status ?? RUN_STATUS.PENDING);
  const paused = running && status === RUN_STATUS.PAUSED;
  const controlRunId = runId ?? (events.length > 0 ? events[events.length - 1].runId : undefined);

  const controlRun = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!controlRunId) return;
    try {
      await invokeControlRun(action, controlRunId);
    } catch (err) {
      onToast(String(err), true);
    }
  };

  const allSteps = useMemo(() => buildSteps(events), [events]);
  const q = query.trim().toLowerCase();
  const steps = useMemo(
    () => (q ? allSteps.filter((s) => stepHaystack(s).includes(q)) : allSteps),
    [allSteps, q],
  );

  // Replay material (T13): session video + trace.zip. Screenshots render
  // inline in the step list, so no separate strip is needed.
  const video = (artifacts ?? []).find((a) => a.kind === ArtifactKind.ARTIFACT_KIND_VIDEO) ?? null;
  const trace = (artifacts ?? []).find((a) => a.kind === ArtifactKind.ARTIFACT_KIND_TRACE) ?? null;

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

  // Elapsed clock that skips paused spans: pause periods are accumulated in
  // a ref and subtracted, so a paused run does not inflate the shown time.
  const pauseStartRef = useRef(0);
  const pausedTotalRef = useRef(0);
  useEffect(() => {
    if (!running) return;
    if (paused) {
      pauseStartRef.current = Date.now();
      return;
    }
    if (pauseStartRef.current) {
      pausedTotalRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = 0;
    }
  }, [paused, running]);

  useEffect(() => {
    if (!running) return;
    // A fresh run restarts the clock: without the reset the timer would carry
    // the previous run's elapsed value into the new run.
    setElapsedMs(0);
    pauseStartRef.current = 0;
    pausedTotalRef.current = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      const pauseSpan = pauseStartRef.current ? Date.now() - pauseStartRef.current : 0;
      setElapsedMs(Math.max(0, Date.now() - started - pausedTotalRef.current - pauseSpan));
    }, 500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Total span of the timeline bar: last event offset, extended by the live
  // clock while running and by the run's recorded duration after completion.
  const totalMs = useMemo(() => {
    if (!events.length) return 0;
    const t0 = Date.parse(events[0].timestamp);
    const last = Date.parse(events[events.length - 1].timestamp);
    const lastRel = Number.isNaN(t0) || Number.isNaN(last) ? 0 : Math.max(0, last - t0);
    const base = Math.max(lastRel, finalRun?.durationMs ?? 0);
    return running ? Math.max(base, elapsedMs) : base;
  }, [events, running, elapsedMs, finalRun]);

  // Follow the live feed; a replay transcript starts at the top.
  useEffect(() => {
    if (!running) return;
    const el = feedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [events.length, running]);

  const scrollToStep = useCallback((key: string) => {
    document.getElementById(`hstep-${key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  return (
    <section className="sec">
      <div className="shead">
        <h2>
          {t(replay ? 'runPanel.replayTitle' : 'runPanel.title')} · <span className="mono">{caseTitle}</span>
          {runId && (
            <span className="mono dim" title={runId} style={{ marginLeft: 8, fontSize: 12 }}>
              {t('common.runId')} #{runId.slice(0, 8)}
            </span>
          )}
          {envName && <span className="badge" style={{ marginLeft: 8 }}>{envName}</span>}
        </h2>
        <span className="more">
          {running && !replay && controlRunId && (
            <>
              {paused ? (
                <button className="btn sm" style={{ marginRight: 8 }} onClick={() => void controlRun('resume')}>
                  ▶ {t('runPanel.resume')}
                </button>
              ) : (
                <button className="btn sm" style={{ marginRight: 8 }} onClick={() => void controlRun('pause')}>
                  ⏸ {t('runPanel.pause')}
                </button>
              )}
              <button className="btn sm" style={{ marginRight: 8 }} onClick={() => void controlRun('cancel')}>
                ■ {t('runPanel.stop')}
              </button>
            </>
          )}
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
            {t('runPanel.steps')}: <b className="num">{allSteps.length}</b>
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

      <div className="panelbox" style={{ marginTop: replay && video ? 12 : 0 }}>
        <div className="panelh">
          <span>{t(replay ? 'runPanel.transcript' : 'runPanel.events')}</span>
        </div>
        {events.length > 0 && (
          <>
            <RunTimelineBar events={events} totalMs={totalMs} onPickShot={scrollToStep} />
            <div className="rtoolbar">
              <input
                className="inline-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('runPanel.searchPlaceholder')}
              />
              <span className="ct">{t('runPanel.stepsCount', { n: steps.length })}</span>
            </div>
          </>
        )}
        <div className="steps" ref={feedRef}>
          {steps.map((s) => (
            <StepRow key={s.key} step={s} onZoom={setZoom} onToast={onToast} />
          ))}
          {events.length === 0 && (
            <div className="step">
              <span className="bd dim">{t(replay ? 'runPanel.loadingRun' : 'runPanel.empty')}</span>
            </div>
          )}
          {events.length > 0 && steps.length === 0 && (
            <div className="step">
              <span className="bd dim">{t('runPanel.noMatch')}</span>
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
