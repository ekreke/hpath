// Environments view: CRUD against UpsertEnv/DeleteEnv (empty id = create),
// managed here while the sidebar env tree handles selection. The default
// flag is shown per row and toggled via UpsertEnv with isDefault=true; the
// server clears the project's previous default in the same call.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Env } from '@hpath/contract';
import { invokeDeleteEnv, invokeUpsertEnv } from '../lib/ipc';
import EnvFormModal from '../components/EnvFormModal';

type EnvsViewProps = {
  projectId: string | null;
  envs: Env[];
  onChanged: () => void;
  onToast: (text: string, error?: boolean) => void;
};

function EnvsView({ projectId, envs, onChanged, onToast }: EnvsViewProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Env | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async (env: Env) => {
    setBusy(true);
    try {
      await invokeDeleteEnv(env.id);
      onChanged();
      onToast(t('envs.deleted', { name: env.name }));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (env: Env) => {
    setBusy(true);
    try {
      await invokeUpsertEnv({ ...env, isDefault: true });
      onChanged();
      onToast(t('envs.defaultSet', { name: env.name }));
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
          <button className="btn w" onClick={() => setCreating(true)}>
            ＋ {t('envs.new')}
          </button>
        </div>
      </div>

      <section className="sec">
        <table className="tbl">
          <thead>
            <tr>
              <th className="ellip">{t('envs.colName')}</th>
              <th className="col-3" style={{ width: '18%' }}>{t('envs.colWeb')}</th>
              <th className="col-3" style={{ width: '18%' }}>{t('envs.colGrpc')}</th>
              <th className="num col-2" style={{ width: '7%' }}>{t('envs.colVars')}</th>
              <th className="col-2" style={{ width: '11%' }}>{t('envs.colDefault')}</th>
              <th style={{ width: '22%' }} />
            </tr>
          </thead>
          <tbody>
            {envs.map((env) => (
              <tr key={env.id}>
                <td className="mono ellip">{env.name}</td>
                <td className="mono dim col-3 ellip">{env.webBaseUrl || '—'}</td>
                <td className="mono dim col-3 ellip">{env.grpcAddress || '—'}</td>
                <td className="num col-2">{Object.keys(env.vars ?? {}).length}</td>
                <td className="col-2">{env.isDefault ? <span className="pill">{t('envs.defaultMark')}</span> : ''}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'normal' }}>
                  <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {!env.isDefault && (
                      <button className="btn sm ghost" disabled={busy} onClick={() => void setDefault(env)}>
                        {t('envs.setDefault')}
                      </button>
                    )}
                    <button className="btn sm" disabled={busy} onClick={() => setEditing(env)}>
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
                <td colSpan={6} className="empty">{t('envs.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {(creating || editing) && (
        <EnvFormModal
          projectId={projectId}
          env={editing}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            onChanged();
          }}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onToast={onToast}
        />
      )}
    </div>
  );
}

export default EnvsView;
