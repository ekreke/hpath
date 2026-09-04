// Settings view with sub-tabs shared by the chat page and the agents:
//   - Models: provider configuration (default model, provider JSON editor).
//     The provider document is an opencode-style JSON string (baseUrl /
//     apiKey / models with a multimodal flag); the default model must be
//     multimodal-capable (the agents and chat send screenshots). Edits go
//     through a secondary modal and are validated + persisted server-side
//     via UpdateSettings.
//   - Server: gRPC server address (moved here from the top bar); applying
//     persists to localStorage and re-connects in App.
//   - General: UI language toggle (moved here from the top bar).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '../components/Select';
import { invokeGetSettings, invokeUpdateSettings, type AppSettings } from '../lib/ipc';

type SettingsViewProps = {
  onToast: (text: string, error?: boolean) => void;
  serverAddr: string;
  onServerAddrChange: (addr: string) => void;
  onApplyServer: () => void;
  connectionStatus: 'connected' | 'connecting' | 'offline';
};

type SettingsTab = 'models' | 'server' | 'general';

type ProviderModel = {
  id: string;
  name?: string;
  multimodal?: boolean;
};

type ParsedConfig = {
  providers: Record<string, { name?: string; baseUrl?: string; apiKey?: string; models?: ProviderModel[] }>;
  defaultModel?: string;
};

function parseProviderConfig(json: string): ParsedConfig {
  const parsed = JSON.parse(json) as ParsedConfig;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.providers !== 'object') {
    throw new Error('providers object missing');
  }
  return parsed;
}

function SettingsView({
  onToast,
  serverAddr,
  onServerAddrChange,
  onApplyServer,
  connectionStatus,
}: SettingsViewProps) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('models');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaultModel, setDefaultModel] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const s = await invokeGetSettings();
      setSettings(s);
      setDefaultModel(s.defaultModel);
    } catch (err) {
      onToast(String(err), true);
    }
  }, [onToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const parsed: ParsedConfig | null = (() => {
    if (!settings) return null;
    try {
      return parseProviderConfig(settings.providerConfigJson);
    } catch {
      return null;
    }
  })();

  const models: { providerId: string; model: ProviderModel }[] = [];
  if (parsed) {
    for (const [providerId, provider] of Object.entries(parsed.providers)) {
      for (const model of provider.models ?? []) {
        if (model.id) models.push({ providerId, model });
      }
    }
  }

  const saveDefaultModel = async (modelId: string) => {
    if (!settings || modelId === defaultModel) return;
    setBusy(true);
    try {
      const saved = await invokeUpdateSettings({
        providerConfigJson: settings.providerConfigJson,
        defaultModel: modelId,
      });
      setSettings(saved);
      setDefaultModel(saved.defaultModel);
      onToast(t('settings.saved'));
    } catch (err) {
      onToast(String(err), true);
      setDefaultModel(settings.defaultModel);
    } finally {
      setBusy(false);
    }
  };

  const openEditor = () => {
    setEditorText(settings?.providerConfigJson ?? '');
    setEditorOpen(true);
  };

  const saveEditor = async () => {
    try {
      // Client-side parse for fast feedback; the server re-validates the
      // full schema (including the multimodal default rule).
      parseProviderConfig(editorText);
    } catch (err) {
      onToast(t('settings.invalidJson', { reason: err instanceof Error ? err.message : String(err) }), true);
      return;
    }
    setBusy(true);
    try {
      const saved = await invokeUpdateSettings({
        providerConfigJson: editorText,
        defaultModel,
      });
      setSettings(saved);
      setDefaultModel(saved.defaultModel);
      setEditorOpen(false);
      onToast(t('settings.saved'));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const changeLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem('hpath.lang', lang);
  };

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'models', label: t('settings.tabModels') },
    { id: 'server', label: t('settings.tabServer') },
    { id: 'general', label: t('settings.tabGeneral') },
  ];

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>{t('settings.title')}</h1>
          <div className="path">{t('settings.subtitle')}</div>
        </div>
        <div className="btns">
          <div className="seg" aria-label={t('settings.title')}>
            {tabs.map(({ id, label }) => (
              <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'models' && (
        <section className="sec">
          <div className="field" style={{ maxWidth: 480 }}>
            <label>{t('settings.defaultModel')}</label>
            <Select
              value={defaultModel || null}
              ariaLabel={t('settings.defaultModel')}
              placeholder={t('settings.noModels')}
              disabled={busy}
              options={models.map(({ model }) => ({
                value: model.id,
                label: (model.name ?? model.id) + (!model.multimodal ? ` — ${t('settings.notMultimodal')}` : ''),
                disabled: !model.multimodal,
              }))}
              onChange={(v) => void saveDefaultModel(v)}
            />
            <div className="hint">{t('settings.defaultModelHint')}</div>
          </div>

          <div className="kv" style={{ gridTemplateColumns: '140px 1fr', gap: '6px 12px' }}>
            <div className="k">{t('settings.endpoint')}</div>
            <div className="v mono">{parsed ? Object.values(parsed.providers).map((p) => p.baseUrl ?? '—').join(', ') : '—'}</div>
            <div className="k">{t('settings.models')}</div>
            <div className="v">
              {models.map(({ providerId, model }) => (
                <span key={`${providerId}/${model.id}`} className="pill" style={{ marginRight: 6 }}>
                  {model.id}
                  {model.multimodal ? ' ◆' : ''}
                </span>
              ))}
            </div>
          </div>
          <p className="hint">◆ {t('settings.multimodalMark')}</p>

          <div className="btns" style={{ marginTop: 14 }}>
            <button className="btn w" disabled={busy || !settings} onClick={openEditor}>
              {t('settings.editProvider')}
            </button>
          </div>
        </section>
      )}

      {tab === 'server' && (
        <section className="sec">
          <div className="field" style={{ maxWidth: 480 }}>
            <label>{t('settings.serverAddress')}</label>
            <input
              value={serverAddr}
              placeholder="127.0.0.1:50051"
              onChange={(e) => onServerAddrChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onApplyServer();
              }}
            />
            <div className="hint">
              {t(`topbar.${connectionStatus}`)} · {t('settings.serverHint')}
            </div>
          </div>
          <div className="btns">
            <button className="btn w" onClick={onApplyServer}>
              {t('settings.apply')}
            </button>
          </div>
        </section>
      )}

      {tab === 'general' && (
        <section className="sec">
          <div className="field" style={{ maxWidth: 480 }}>
            <label>{t('settings.language')}</label>
            <Select
              value={i18n.language.startsWith('zh') ? 'zh' : 'en'}
              ariaLabel={t('settings.language')}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
              onChange={changeLanguage}
            />
          </div>
        </section>
      )}

      {editorOpen && (
        <div className="overlay" onClick={() => setEditorOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('settings.editTitle')}</h3>
            <div className="field">
              <label>{t('settings.providerJson')}</label>
              <textarea
                rows={16}
                className="mono"
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                value={editorText}
                spellCheck={false}
                onChange={(e) => setEditorText(e.target.value)}
              />
            </div>
            <div className="mfoot">
              <button className="btn ghost" onClick={() => setEditorOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn w" disabled={busy} onClick={() => void saveEditor()}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsView;
