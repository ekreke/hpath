// API list view (Swagger-style): the project's proto assets parsed into a
// grouped method list. Read-only display; each method expands inline to its
// markdown schema and a "try it out" call panel that invokes the method
// against the env picked in the header (target = env's gRPC address).
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invokeListAssets, invokeMethod, type ApiMethod, type InvokeMethodResult } from '../lib/ipc';
import { ASSET_TYPE } from '../lib/ipc';
import { Select } from '../components/Select';
import type { Env } from '@hpath/contract';

type ApiViewProps = {
  projectId: string | null;
  envs: Env[];
  selectedEnvId: string | null;
  onSelectEnv: (id: string | null) => void;
  onToast: (text: string, error?: boolean) => void;
};

function MethodKey(m: ApiMethod): string {
  return `${m.service}/${m.method}`;
}

function ApiView({ projectId, envs, selectedEnvId, onSelectEnv, onToast }: ApiViewProps) {
  const { t } = useTranslation();
  const [methods, setMethods] = useState<ApiMethod[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [requestJson, setRequestJson] = useState('{}');
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<InvokeMethodResult | null>(null);

  const selectedEnv = envs.find((e) => e.id === selectedEnvId) ?? null;

  useEffect(() => {
    if (!projectId) {
      setMethods([]);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const assets = await invokeListAssets(projectId, ASSET_TYPE.PROTO);
        if (cancelled) return;
        setMethods(assets.flatMap((a) => a.methods ?? []));
        setLoaded(true);
      } catch (err) {
        if (!cancelled) onToast(String(err), true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const grouped = useMemo(() => {
    const map = new Map<string, ApiMethod[]>();
    for (const m of methods) {
      const list = map.get(m.service) ?? [];
      list.push(m);
      map.set(m.service, list);
    }
    return [...map.entries()];
  }, [methods]);

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = prev === key ? null : key;
      if (next !== prev) {
        setResult(null);
        setRequestJson('{}');
      }
      return next;
    });
  };

  const call = async (m: ApiMethod) => {
    if (!selectedEnvId) {
      onToast(t('api.pickEnvFirst'), true);
      return;
    }
    setInvoking(true);
    setResult(null);
    try {
      const res = await invokeMethod(selectedEnvId, MethodKey(m), requestJson);
      setResult(res);
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setInvoking(false);
    }
  };

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>
            {t('api.title')} <span className="pill">{methods.length}</span>
          </h1>
          <div className="path">{t('api.subtitle')}</div>
        </div>
        <div className="btns">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="hint">{t('api.env')}</span>
            <div style={{ width: 160 }}>
              <Select
                ariaLabel={t('api.env')}
                variant="bordered"
                value={selectedEnvId}
                placeholder={t('cases.pickEnv')}
                options={envs.map((e) => ({ value: e.id, label: e.name }))}
                onChange={(v) => onSelectEnv(v || null)}
              />
            </div>
          </div>
        </div>
      </div>

      {!loaded ? null : methods.length === 0 ? (
        <div className="empty">{t('api.empty')}</div>
      ) : (
        grouped.map(([service, list]) => (
          <section className="sec" key={service}>
            <div className="shead">
              <h2 className="mono" style={{ fontSize: 14 }}>{service}</h2>
              <span className="n">{list.length}</span>
            </div>
            <div className="panelbox" style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: '18%' }}>{t('api.colMethod')}</th>
                    <th className="col-2" style={{ width: '24%' }}>{t('api.colRequest')}</th>
                    <th className="col-2" style={{ width: '20%' }}>{t('api.colResponse')}</th>
                    <th>{t('api.colComment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((m) => {
                    const key = MethodKey(m);
                    const open = expanded === key;
                    return (
                      <MethodRow
                        key={key}
                        method={m}
                        open={open}
                        invoking={invoking}
                        requestJson={requestJson}
                        result={result}
                        hasEnv={!!selectedEnvId}
                        onToggle={() => toggle(key)}
                        onRequestJson={setRequestJson}
                        onCall={() => void call(m)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      {loaded && methods.length > 0 && !selectedEnv && (
        <p className="hint">{t('api.envHint')}</p>
      )}
    </div>
  );
}

type MethodRowProps = {
  method: ApiMethod;
  open: boolean;
  invoking: boolean;
  requestJson: string;
  result: InvokeMethodResult | null;
  hasEnv: boolean;
  onToggle: () => void;
  onRequestJson: (v: string) => void;
  onCall: () => void;
};

function MethodRow({
  method,
  open,
  invoking,
  requestJson,
  result,
  hasEnv,
  onToggle,
  onRequestJson,
  onCall,
}: MethodRowProps) {
  const { t } = useTranslation();
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="mono ellip" style={{ color: 'var(--w)' }}>
          {open ? '▾' : '▸'} {method.method}
        </td>
        <td className="mono dim col-2 ellip">{method.request}</td>
        <td className="mono dim col-2 ellip">{method.response}</td>
        <td className="dim" style={{ whiteSpace: 'normal' }}>{method.comment || '—'}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ background: 'var(--panel2)' }}>
            <div style={{ padding: '10px 6px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="md" style={{ fontSize: 12.5, lineHeight: 1.5, maxHeight: 260, overflowY: 'auto' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{method.doc}</ReactMarkdown>
              </div>
              <div>
                <div className="hint" style={{ marginBottom: 6 }}>{t('api.requestJson')}</div>
                <textarea
                  className="inline-input mono"
                  style={{ width: '100%', minHeight: 84, resize: 'vertical', fontFamily: 'var(--mono, monospace)' }}
                  value={requestJson}
                  onChange={(e) => onRequestJson(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="btn w sm" disabled={invoking || !hasEnv} onClick={onCall}>
                  {invoking ? t('api.invoking') : `▶ ${t('api.invoke')}`}
                </button>
                {!hasEnv && <span className="hint">{t('api.pickEnvFirst')}</span>}
              </div>
              {result && (
                <div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                    <span className={`tag ${result.ok ? 'run' : 'fail'}`}>
                      {result.ok ? t('api.ok') : t('api.failed')}
                    </span>
                    <span className="hint mono">
                      {result.target} · {result.durationMs} ms
                      {!result.ok && result.errorCode ? ` · ${result.errorCode}` : ''}
                    </span>
                  </div>
                  {!result.ok && result.errorDetails && (
                    <div className="hint" style={{ marginBottom: 6 }}>{result.errorDetails}</div>
                  )}
                  <pre
                    className="mono-block"
                    style={{ maxHeight: 240, overflowY: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}
                  >
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(result.responseJson), null, 2);
                      } catch {
                        return result.responseJson;
                      }
                    })()}
                  </pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default ApiView;
