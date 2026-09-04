// Settings view: model provider configuration for the chat page and the
// agents. The provider document is an opencode-style JSON string
// (baseUrl / apiKey / models with a multimodal flag); the default model must
// be multimodal-capable (the agents and chat send screenshots). Edits go
// through a secondary modal and are validated + persisted server-side via
// UpdateSettings.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invokeGetSettings, invokeUpdateSettings, type AppSettings } from '../lib/ipc';

type SettingsViewProps = {
  onToast: (text: string, error?: boolean) => void;
};

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

function SettingsView({ onToast }: SettingsViewProps) {
  const { t } = useTranslation();
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

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>{t('settings.title')}</h1>
          <div className="path">{t('settings.subtitle')}</div>
        </div>
        <div className="btns">
          <button className="btn w" disabled={busy || !settings} onClick={openEditor}>
            {t('settings.editProvider')}
          </button>
        </div>
      </div>

      <section className="sec">
        <div className="field" style={{ maxWidth: 480 }}>
          <label>{t('settings.defaultModel')}</label>
          <select
            value={defaultModel}
            disabled={busy || models.length === 0}
            onChange={(e) => void saveDefaultModel(e.target.value)}
          >
            {models.length === 0 && <option value="">{t('settings.noModels')}</option>}
            {models.map(({ providerId, model }) => (
              <option key={`${providerId}/${model.id}`} value={model.id} disabled={!model.multimodal}>
                {model.name ?? model.id}
                {!model.multimodal ? ` — ${t('settings.notMultimodal')}` : ''}
              </option>
            ))}
          </select>
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
      </section>

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
