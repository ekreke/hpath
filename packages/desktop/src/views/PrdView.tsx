// PRD view: upload (md/docx/pdf), live parse event trace, created drafts.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { invokeParsePrd, type ParseEvent, type ParsePrdResult } from '../lib/ipc';
import { PRD_FORMAT } from '../lib/status';
import { CaseStatusBadge } from '../components/Ui';

type PrdViewProps = {
  projectId: string | null;
  onDraftsCreated: () => void;
  onToast: (text: string, error?: boolean) => void;
};

const PARSE_EVENT = 'parse-prd-event';

const ACCEPT = '.md,.docx,.pdf';

function detectFormat(filename: string): number {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) return PRD_FORMAT.DOCX;
  if (lower.endsWith('.pdf')) return PRD_FORMAT.PDF;
  return PRD_FORMAT.MD;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function PrdView({ projectId, onDraftsCreated, onToast }: PrdViewProps) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<ParseEvent[]>([]);
  const [result, setResult] = useState<ParsePrdResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<ParseEvent>(PARSE_EVENT, (event) => {
      setEvents((prev) => [...prev, event.payload]);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events]);

  const start = async (file: File) => {
    if (!projectId) {
      onToast(t('common.selectProjectFirst'), true);
      return;
    }
    setBusy(true);
    setEvents([]);
    setResult(null);
    try {
      const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
      const res = await invokeParsePrd(
        projectId,
        file.name,
        detectFormat(file.name),
        contentBase64,
      );
      setResult(res);
      onDraftsCreated();
      onToast(t('prd.parsed', { count: res.drafts.length }));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>{t('prd.title')}</h1>
          <div className="path">{t('prd.subtitle')}</div>
        </div>
        <div className="btns">
          <button className="btn w" disabled={busy || !projectId} onClick={() => fileRef.current?.click()}>
            {busy ? t('prd.parsing') : `＋ ${t('prd.upload')}`}
          </button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void start(file);
        }}
      />

      <div className="grid2">
        <section className="sec">
          <div className="shead">
            <h2>{t('prd.traceTitle')}</h2>
            <span className="n">{events.length}</span>
          </div>
          <div className="panelbox">
            <div className="log" ref={logRef} style={{ maxHeight: 380, overflowY: 'auto' }}>
              {events.map((ev, i) => (
                <div className="ln" key={i}>
                  <span className="ts">{new Date().toLocaleTimeString(i18n.language)}</span>
                  <span className="tx">
                    {ev.kind === 'thinking' && <><b>think</b> {ev.text}</>}
                    {ev.kind === 'progress' && (
                      <>
                        <b>progress</b> {ev.pct}% · {ev.message}
                      </>
                    )}
                    {ev.kind === 'prdRegistered' && (
                      <>
                        <b>prd</b> {ev.prd?.filename} ({ev.prd?.sizeBytes} bytes)
                      </>
                    )}
                    {ev.kind === 'draftsCreated' && (
                      <>
                        <b>drafts</b> {ev.caseIds?.length ?? 0} created
                      </>
                    )}
                    {ev.kind === 'error' && (
                      <>
                        <b>error</b> {ev.errorKind}: {ev.errorMessage}
                      </>
                    )}
                  </span>
                </div>
              ))}
              {events.length === 0 && (
                <div className="ln">
                  <span className="tx" style={{ color: 'var(--faint2)' }}>{t('prd.traceEmpty')}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside>
          <div className="panelbox">
            <div className="panelh">
              <span>{t('prd.draftsTitle')}</span>
              {result && <b className="mono">{result.drafts.length}</b>}
            </div>
            {result && result.drafts.length > 0 ? (
              <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {result.drafts.map((draft) => (
                  <div key={draft.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CaseStatusBadge status={draft.status} />
                      <span className="mono" style={{ color: 'var(--w)' }}>{draft.title}</span>
                    </div>
                    <div className="hint" style={{ marginTop: 2 }}>
                      {t('prd.reviewHint')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mono-block" style={{ color: 'var(--faint)' }}>
                {t('prd.draftsEmpty')}
              </div>
            )}
          </div>
          <p className="hint" style={{ marginTop: 14 }}>
            {t('prd.formatsHint')}
          </p>
        </aside>
      </div>
    </div>
  );
}

export default PrdView;
