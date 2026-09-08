// Asset library view (T22): typed uploads (PRD / proto) via a modal form,
// the project's asset list, proto API-doc preview and the PRD parse trace.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ASSET_TYPE,
  invokeDeleteAsset,
  invokeGetAsset,
  invokeListAssets,
  invokeParsePrd,
  invokeUploadAsset,
  type Asset,
  type AssetFileInput,
  type ParseEvent,
  type ParsePrdResult,
} from '../lib/ipc';
import { PRD_FORMAT } from '../lib/status';
import { CaseStatusBadge } from '../components/Ui';

type AssetViewProps = {
  projectId: string | null;
  onDraftsCreated: () => void;
  onToast: (text: string, error?: boolean) => void;
};

const PARSE_EVENT = 'parse-prd-event';

const PRD_ACCEPT = '.md,.docx,.pdf';

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

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function AssetView({ projectId, onDraftsCreated, onToast }: AssetViewProps) {
  const { t, i18n } = useTranslation();
  // Library state
  const [assets, setAssets] = useState<Asset[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Asset | null>(null);
  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadType, setUploadType] = useState<'prd' | 'proto'>('proto');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [entryFile, setEntryFile] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // PRD parse flow (streaming trace + drafts, unchanged contract)
  const [events, setEvents] = useState<ParseEvent[]>([]);
  const [result, setResult] = useState<ParsePrdResult | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = async (pid: string) => {
    try {
      setAssets(await invokeListAssets(pid));
    } catch (err) {
      onToast(String(err), true);
    }
  };

  useEffect(() => {
    if (projectId) void refresh(projectId);
    else setAssets([]);
  }, [projectId]);

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

  const openUpload = () => {
    if (!projectId) {
      onToast(t('common.selectProjectFirst'), true);
      return;
    }
    setUploadType('proto');
    setPendingFiles([]);
    setEntryFile('');
    setUploadOpen(true);
  };

  const pickFiles = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    setPendingFiles(files);
    // Default the entry to the file no other selected name hints at; the
    // first file is the sane default for flat bundles.
    setEntryFile(files[0]?.name ?? '');
  };

  const submitUpload = async () => {
    if (!projectId || pendingFiles.length === 0) return;
    setUploading(true);
    try {
      if (uploadType === 'prd') {
        // PRD rides the ParsePRD analyze flow (streaming trace below).
        const file = pendingFiles[0]!;
        setEvents([]);
        setResult(null);
        setUploadOpen(false);
        const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const res = await invokeParsePrd(projectId, file.name, detectFormat(file.name), contentBase64);
        setResult(res);
        onDraftsCreated();
        void refresh(projectId);
        onToast(t('prd.parsed', { count: res.drafts.length }));
      } else {
        // Proto bundle: deterministic server-side parse into the API surface.
        if (!pendingFiles.every((file) => file.name.toLowerCase().endsWith('.proto'))) {
          onToast(t('asset.protoOnly'), true);
          return;
        }
        const files: AssetFileInput[] = await Promise.all(
          pendingFiles.map(async (file) => ({
            filename: file.name,
            contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
          })),
        );
        const entry = pendingFiles.length > 1 ? entryFile : pendingFiles[0]?.name ?? '';
        const asset = await invokeUploadAsset(projectId, ASSET_TYPE.PROTO, files, entry);
        setUploadOpen(false);
        void refresh(projectId);
        onToast(t('asset.uploaded', { name: asset.filename }));
      }
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (asset: Asset) => {
    if (confirmId !== asset.id) {
      setConfirmId(asset.id);
      return;
    }
    setConfirmId(null);
    try {
      await invokeDeleteAsset(asset.id);
      void refresh(projectId!);
      onToast(t('asset.deleted', { name: asset.filename }));
    } catch (err) {
      onToast(String(err), true);
    }
  };

  const openPreview = async (asset: Asset) => {
    try {
      setPreview(await invokeGetAsset(asset.id));
    } catch (err) {
      onToast(String(err), true);
    }
  };

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>{t('asset.title')}</h1>
          <div className="path">{t('asset.subtitle')}</div>
        </div>
        <div className="btns">
          <button className="btn w" disabled={!projectId} onClick={openUpload}>
            ＋ {t('asset.upload')}
          </button>
        </div>
      </div>

      {/* Asset list ------------------------------------------------------- */}
      <section className="sec" style={{ marginTop: 14 }}>
        <div className="shead">
          <h2>{t('asset.libraryTitle')}</h2>
          <span className="n">{assets.length}</span>
        </div>
        {assets.length === 0 ? (
          <div className="panelbox">
            <div className="mono-block" style={{ color: 'var(--faint)' }}>{t('asset.empty')}</div>
          </div>
        ) : (
          <div className="panelbox" style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('asset.colType')}</th>
                  <th>{t('asset.colFile')}</th>
                  <th>{t('asset.colFiles')}</th>
                  <th>{t('asset.colSize')}</th>
                  <th>{t('asset.colTime')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <span className={asset.type === ASSET_TYPE.PROTO ? 'tag run' : 'tag pending'}>
                        {asset.type === ASSET_TYPE.PROTO ? t('asset.typeProto') : t('asset.typePrd')}
                      </span>
                    </td>
                    <td className="mono" style={{ color: 'var(--w)' }}>{asset.filename}</td>
                    <td>{asset.fileCount || 1}</td>
                    <td>{formatBytes(asset.sizeBytes)}</td>
                    <td>{new Date(asset.createdAt).toLocaleString(i18n.language)}</td>
                    <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {asset.type === ASSET_TYPE.PROTO && (
                        <button className="btn ghost sm" onClick={() => void openPreview(asset)}>
                          {t('asset.view')}
                        </button>
                      )}
                      <button
                        className="btn ghost sm"
                        style={confirmId === asset.id ? { color: 'var(--danger, #f66)' } : undefined}
                        onClick={() => void remove(asset)}
                      >
                        {confirmId === asset.id ? t('asset.deleteConfirm') : t('common.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Upload modal ------------------------------------------------------ */}
      {uploadOpen && (
        <div className="overlay" onClick={() => setUploadOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('asset.uploadTitle')}</h3>
            <div className="field">
              <label>{t('asset.chooseType')}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['prd', 'proto'] as const).map((option) => (
                  <button
                    key={option}
                    className={`btn sm ${uploadType === option ? '' : 'ghost'}`}
                    onClick={() => {
                      setUploadType(option);
                      setPendingFiles([]);
                      setEntryFile('');
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  >
                    {option === 'prd' ? t('asset.typePrd') : t('asset.typeProto')}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>{t('asset.chooseFiles')}</label>
              <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>
                {pendingFiles.length === 0
                  ? t('asset.pickFiles')
                  : pendingFiles.map((file) => file.name).join(', ')}
              </button>
              <div className="hint" style={{ marginTop: 6 }}>
                {uploadType === 'prd' ? t('asset.prdHint') : t('asset.protoHint')}
              </div>
            </div>
            {uploadType === 'proto' && pendingFiles.length > 1 && (
              <div className="field">
                <label>{t('asset.entryFile')}</label>
                {pendingFiles.map((file) => (
                  <label key={file.name} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <input
                      type="radio"
                      name="entry"
                      checked={entryFile === file.name}
                      onChange={() => setEntryFile(file.name)}
                    />
                    <span className="mono">{file.name}</span>
                  </label>
                ))}
                <div className="hint">{t('asset.entryHint')}</div>
              </div>
            )}
            <div className="mfoot">
              <button className="btn ghost" onClick={() => setUploadOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn w"
                disabled={uploading || pendingFiles.length === 0 || (uploadType === 'proto' && pendingFiles.length > 1 && !entryFile)}
                onClick={() => void submitUpload()}
              >
                {uploading
                  ? t('asset.uploading')
                  : uploadType === 'prd'
                    ? t('asset.uploadAndParse')
                    : t('asset.upload')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input: accept depends on the selected type. */}
      <input
        ref={fileRef}
        type="file"
        multiple={uploadType === 'proto'}
        accept={uploadType === 'prd' ? PRD_ACCEPT : '.proto'}
        style={{ display: 'none' }}
        onChange={(e) => pickFiles(e.target.files)}
      />

      {/* PRD parse trace + drafts ------------------------------------------ */}
      <div className="grid2" style={{ marginTop: 14 }}>
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
                    {ev.kind === 'progress' && (<><b>progress</b> {ev.pct}% · {ev.message}</>)}
                    {ev.kind === 'prdRegistered' && (<><b>prd</b> {ev.prd?.filename} ({ev.prd?.sizeBytes} bytes)</>)}
                    {ev.kind === 'draftsCreated' && (<><b>drafts</b> {ev.caseIds?.length ?? 0} created</>)}
                    {ev.kind === 'error' && (<><b>error</b> {ev.errorKind}: {ev.errorMessage}</>)}
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
        </aside>
      </div>

      {/* API-doc preview modal ---------------------------------------------- */}
      {preview && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <div className="modal" style={{ maxWidth: 720, width: '90%' }} onClick={(e) => e.stopPropagation()}>
            <h3>
              {t('asset.previewTitle')} · <span className="mono">{preview.filename}</span>
            </h3>
            <div
              className="md"
              style={{ maxHeight: '60vh', overflowY: 'auto', fontSize: 13, lineHeight: 1.55 }}
            >
              {preview.apiDoc ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.apiDoc}</ReactMarkdown>
              ) : (
                <p className="hint">{t('asset.noApiDoc')}</p>
              )}
            </div>
            <div className="mfoot">
              <button className="btn ghost" onClick={() => setPreview(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AssetView;
