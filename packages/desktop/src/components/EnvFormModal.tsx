// Shared env create/edit modal, used by the EnvsView management page and
// the sidebar env tree's quick-create button. Persists via UpsertEnv; the
// edit path preserves the env's default flag (toggling the default is a
// separate action on the EnvsView table row).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Env } from '@hpath/contract';
import { invokeUpsertEnv } from '../lib/ipc';

type EnvFormModalProps = {
  projectId: string;
  /** null = create; otherwise the env being edited. */
  env: Env | null;
  onSaved: (env: Env) => void;
  onClose: () => void;
  onToast: (text: string, error?: boolean) => void;
};

type EnvForm = {
  name: string;
  webBaseUrl: string;
  grpcAddress: string;
  varsText: string;
  credentialsText: string;
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

function EnvFormModal({ projectId, env, onSaved, onClose, onToast }: EnvFormModalProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<EnvForm>({
    name: env?.name ?? '',
    webBaseUrl: env?.webBaseUrl ?? '',
    grpcAddress: env?.grpcAddress ?? '',
    varsText: kvToText(env?.vars ?? {}),
    credentialsText: kvToText(env?.credentials ?? {}),
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!form.name.trim()) {
      onToast(t('envs.nameRequired'), true);
      return;
    }
    setBusy(true);
    try {
      const saved = await invokeUpsertEnv({
        id: env?.id ?? '',
        projectId,
        name: form.name.trim(),
        webBaseUrl: form.webBaseUrl.trim(),
        grpcAddress: form.grpcAddress.trim(),
        vars: parseKv(form.varsText),
        credentials: parseKv(form.credentialsText),
        isDefault: env?.isDefault ?? false,
      });
      onSaved(saved);
      onToast(t(env ? 'envs.saved' : 'envs.created'));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t(env ? 'envs.editTitle' : 'envs.createTitle')}</h3>
        <div className="field">
          <label>{t('envs.colName')}</label>
          <input
            autoFocus
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
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn w" disabled={busy} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EnvFormModal;
