// Environments view: CRUD against UpsertEnv/DeleteEnv (empty id = create).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Env } from '@hpath/contract';
import { invokeDeleteEnv, invokeUpsertEnv } from '../lib/ipc';

type EnvsViewProps = {
  addr: string;
  projectId: string | null;
  envs: Env[];
  onChanged: () => void;
  onToast: (text: string, error?: boolean) => void;
};

type EnvForm = {
  id: string;
  name: string;
  webBaseUrl: string;
  grpcAddress: string;
  varsText: string;
  credentialsText: string;
};

const EMPTY_FORM: EnvForm = {
  id: '',
  name: '',
  webBaseUrl: '',
  grpcAddress: '',
  varsText: '',
  credentialsText: '',
};

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function kvToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function EnvsView({ addr, projectId, envs, onChanged, onToast }: EnvsViewProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<EnvForm | null>(null);
  const [busy, setBusy] = useState(false);

  const openCreate = () => setForm({ ...EMPTY_FORM });

  const openEdit = (env: Env) =>
    setForm({
      id: env.id,
      name: env.name,
      webBaseUrl: env.webBaseUrl,
      grpcAddress: env.grpcAddress,
      varsText: kvToText(env.vars ?? {}),
      credentialsText: kvToText(env.credentials ?? {}),
    });

  const save = async () => {
    if (!form || !projectId) return;
    if (!form.name.trim()) {
      onToast(t('envs.nameRequired'), true);
      return;
    }
    setBusy(true);
    try {
      await invokeUpsertEnv(addr, {
        id: form.id,
        projectId,
        name: form.name.trim(),
        webBaseUrl: form.webBaseUrl.trim(),
        grpcAddress: form.grpcAddress.trim(),
        vars: parseKv(form.varsText),
        credentials: parseKv(form.credentialsText),
      });
      setForm(null);
      onChanged();
      onToast(t(form.id ? 'envs.saved' : 'envs.created'));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (env: Env) => {
    setBusy(true);
    try {
      await invokeDeleteEnv(addr, env.id);
      onChanged();
      onToast(t('envs.deleted', { name: env.name }));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  if (!projectId) {
    return (
      <div className="page-inner">
        <div className="ph">
          <h1>{t('envs.title')}</h1>
        </div>
        <p className="hint">{t('common.selectProjectFirst')}</p>
      </div>
    );
  }

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>
            {t('envs.title')} <span className="pill">{envs.length}</span>
          </h1>
          <div className="path">{t('envs.subtitle')}</div>
        </div>
        <div className="btns">
          <button className="btn w" onClick={openCreate}>
            ＋ {t('envs.new')}
          </button>
        </div>
      </div>

      <section className="sec">
        <table>
          <thead>
            <tr>
              <th>{t('envs.colName')}</th>
              <th>{t('envs.colWeb')}</th>
              <th>{t('envs.colGrpc')}</th>
              <th className="num">{t('envs.colVars')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {envs.map((env) => (
              <tr key={env.id}>
                <td className="mono">{env.name}</td>
                <td className="mono dim">{env.webBaseUrl || '—'}</td>
                <td className="mono dim">{env.grpcAddress || '—'}</td>
                <td className="num">{Object.keys(env.vars ?? {}).length}</td>
                <td style={{ textAlign: 'right' }}>
                  <span style={{ display: 'inline-flex', gap: 8 }}>
                    <button className="btn sm" disabled={busy} onClick={() => openEdit(env)}>
                      {t('common.edit')}
                    </button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => void remove(env)}>
                      {t('common.delete')}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {envs.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">{t('envs.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {form && (
        <div className="overlay" onClick={() => setForm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{form.id ? t('envs.editTitle') : t('envs.createTitle')}</h3>
            <div className="field">
              <label>{t('envs.colName')}</label>
              <input
                value={form.name}
                placeholder="staging"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('envs.colWeb')}</label>
              <input
                value={form.webBaseUrl}
                placeholder="http://demo-app-staging:3000"
                onChange={(e) => setForm({ ...form, webBaseUrl: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('envs.colGrpc')}</label>
              <input
                value={form.grpcAddress}
                placeholder="demo-app-staging:50052"
                onChange={(e) => setForm({ ...form, grpcAddress: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('envs.vars')}</label>
              <textarea
                rows={3}
                className="mono"
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                value={form.varsText}
                placeholder={'K1=V1\nK2=V2'}
                onChange={(e) => setForm({ ...form, varsText: e.target.value })}
              />
            </div>
            <div className="field">
              <label>{t('envs.credentials')}</label>
              <textarea
                rows={2}
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                value={form.credentialsText}
                onChange={(e) => setForm({ ...form, credentialsText: e.target.value })}
              />
            </div>
            <div className="mfoot">
              <button className="btn ghost" onClick={() => setForm(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn w" disabled={busy} onClick={() => void save()}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default EnvsView;
