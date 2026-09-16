// Settings view with sub-tabs shared by the chat page and the agents:
//   - Models: provider configuration (default model, browser pool size,
//     provider JSON editor).
//     The provider document is an opencode-style JSON string (baseUrl /
//     apiKey / models with a multimodal flag); the default model must be
//     multimodal-capable (the agents and chat send screenshots). Edits go
//     through a secondary modal and are validated + persisted server-side
//     via UpdateSettings. The browser pool size (T23) is a separate numeric
//     field on the wire (0 = disabled, server-capped at 4).
//   - Server: gRPC server address (moved here from the top bar); applying
//     persists to localStorage and re-connects in App.
//   - General: UI language toggle plus per-agent defaults (model + extra
//     prompt), one block per registered agent as reported by the server.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '../components/Select';
import { invokeGetSettings, invokeUpdateSettings, type AgentSettings, type AppSettings, type BrowserEngineId } from '../lib/ipc';

type SettingsViewProps = {
  onToast: (text: string, error?: boolean) => void;
  serverAddr: string;
  onServerAddrChange: (addr: string) => void;
  onApplyServer: () => void;
  connectionStatus: 'connected' | 'connecting' | 'offline';
};

type SettingsTab = 'models' | 'server' | 'general';

// Radix Select forbids empty-string item values; this sentinel maps to "use
// the default model" for a per-agent model override.
const AGENT_MODEL_DEFAULT = '__default__';

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
  const [browserPool, setBrowserPool] = useState(1);
  const [browserEngine, setBrowserEngine] = useState<BrowserEngineId>('playwright');
  const [agents, setAgents] = useState<AgentSettings[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [busy, setBusy] = useState(false);

  const applySaved = useCallback((saved: AppSettings) => {
    setSettings(saved);
    setDefaultModel(saved.defaultModel);
    setBrowserPool(saved.browserPoolSize);
    setBrowserEngine(saved.browserEngine);
    setAgents(saved.agents ?? []);
    return saved;
  }, []);

  const reload = useCallback(async () => {
    try {
      applySaved(await invokeGetSettings());
    } catch (err) {
      onToast(String(err), true);
    }
  }, [onToast, applySaved]);

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

  // Every save submits the FULL settings document (including the per-agent
  // defaults) so a change in one section never wipes another.
  const saveSettings = async (patch: Partial<AppSettings>): Promise<AppSettings | null> => {
    if (!settings) return null;
    setBusy(true);
    try {
      const saved = await invokeUpdateSettings({
        providerConfigJson: patch.providerConfigJson ?? settings.providerConfigJson,
        defaultModel: patch.defaultModel ?? defaultModel,
        browserPoolSize: patch.browserPoolSize ?? browserPool,
        browserEngine: patch.browserEngine ?? browserEngine,
        agents: patch.agents ?? agents,
      });
      applySaved(saved);
      onToast(t('settings.saved'));
      return saved;
    } catch (err) {
      onToast(String(err), true);
      // Snap back to the stored document on failure.
      void reload();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveDefaultModel = (modelId: string) => {
    if (modelId === defaultModel) return;
    setDefaultModel(modelId);
    void saveSettings({ defaultModel: modelId });
  };

  // T23: persist the warm browser pool size. The server clamps/validates the
  // value (integer 0-4) and resizes its pool live; on failure the input
  // snaps back to the stored value.
  const saveBrowserPool = (size: number) => {
    if (settings && size === settings.browserPoolSize) return;
    setBrowserPool(size);
    void saveSettings({ browserPoolSize: size });
  };

  // T24: persist the browser engine. Mutually exclusive with the other engine;
  // the server hot-swaps its pool (install is best-effort — an unavailable
  // engine surfaces a clear browser-tool error rather than falling back).
  const saveBrowserEngine = (engine: BrowserEngineId) => {
    if (settings && engine === settings.browserEngine) return;
    setBrowserEngine(engine);
    void saveSettings({ browserEngine: engine });
  };

  const updateAgent = (agentId: string, patch: Partial<AgentSettings>) => {
    setAgents((prev) => prev.map((a) => (a.agentId === agentId ? { ...a, ...patch } : a)));
  };

  const saveAgentModel = (agentId: string, model: string) => {
    const next = agents.map((a) => (a.agentId === agentId ? { ...a, model } : a));
    setAgents(next);
    void saveSettings({ agents: next });
  };

  const saveAgentPrompt = () => {
    void saveSettings({ agents });
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
    const saved = await saveSettings({ providerConfigJson: editorText });
    if (saved) setEditorOpen(false);
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
      </div>

      <div className="settings-grid">
        <aside className="set-nav">
          {tabs.map(({ id, label }) => (
            <button key={id} className={tab === id ? 'itm on' : 'itm'} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </aside>
        <div className="set-content">
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

          <div className="field" style={{ maxWidth: 480 }}>
            <label>{t('settings.browserPool')}</label>
            <Select
              value={String(browserPool)}
              ariaLabel={t('settings.browserPool')}
              disabled={busy}
              options={[0, 1, 2, 3, 4].map((size) => ({
                value: String(size),
                label:
                  size === 0
                    ? t('settings.browserPoolZero')
                    : size === 4
                      ? t('settings.browserPoolMax')
                      : size === 1
                        ? t('settings.browserPoolDefault')
                        : String(size),
              }))}
              onChange={(v) => {
                // Immediate save (server re-validates the 0-4 range).
                const size = Math.max(0, Math.min(4, Number(v) || 0));
                setBrowserPool(size);
                void saveBrowserPool(size);
              }}
            />
            <div className="hint">{t('settings.browserPoolHint')}</div>
          </div>

          <div className="field" style={{ maxWidth: 480 }}>
            <label>{t('settings.browserEngine')}</label>
            <Select
              value={browserEngine}
              ariaLabel={t('settings.browserEngine')}
              disabled={busy}
              options={[
                { value: 'playwright', label: t('settings.browserEnginePlaywright') },
                { value: 'obscura', label: t('settings.browserEngineObscura') },
              ]}
              onChange={(v) => {
                const engine = v as BrowserEngineId;
                setBrowserEngine(engine);
                void saveBrowserEngine(engine);
              }}
            />
            <div className="hint">
              {browserEngine === 'obscura'
                ? t('settings.browserEngineObscuraHint')
                : t('settings.browserEngineHint')}
            </div>
          </div>

          <div className="kv" style={{ gridTemplateColumns: '140px 1fr', gap: '6px 12px' }}>
            <div className="k">{t('settings.endpoint')}</div>
            <div className="v mono">{parsed ? Object.values(parsed.providers).map((p) => p.baseUrl ?? '—').join(', ') : '—'}</div>
            <div className="k">{t('settings.models')}</div>
            <div className="v" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {models.map(({ providerId, model }) => (
                <span
                  key={`${providerId}/${model.id}`}
                  className={`pill model${model.multimodal ? '' : ' dim'}`}
                  title={model.multimodal ? t('settings.multimodal') : t('settings.notMultimodal')}
                >
                  <i className={model.multimodal ? 'mm' : ''} />
                  {model.id}
                </span>
              ))}
              {models.length === 0 && <span className="hint">{t('settings.noModels')}</span>}
            </div>
          </div>
          <p className="hint">
            <i
              className="mm"
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--hc-3)',
                marginRight: 6,
                verticalAlign: 'middle',
              }}
            />
            {t('settings.multimodalMark')}
          </p>

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

          <div className="field" style={{ maxWidth: 560, marginTop: 18 }}>
            <label>{t('settings.agents')}</label>
            <div className="hint">{t('settings.agentsHint')}</div>
          </div>
          {agents.map((agent) => (
            <div className="field" key={agent.agentId} style={{ maxWidth: 560 }}>
              <label>{agent.role || agent.agentId}</label>
              <Select
                value={agent.model || AGENT_MODEL_DEFAULT}
                ariaLabel={`${agent.agentId} ${t('settings.agentModel')}`}
                disabled={busy}
                options={[
                  { value: AGENT_MODEL_DEFAULT, label: `${t('settings.agentModelDefault')} (${defaultModel})` },
                  ...models.map(({ model }) => ({
                    value: model.id,
                    label:
                      (model.name ?? model.id) + (!model.multimodal ? ` — ${t('settings.notMultimodal')}` : ''),
                  })),
                ]}
                onChange={(v) => saveAgentModel(agent.agentId, v === AGENT_MODEL_DEFAULT ? '' : v)}
              />
              <label style={{ marginTop: 10 }}>{t('settings.agentPrompt')}</label>
              <textarea
                rows={3}
                value={agent.prompt}
                spellCheck={false}
                placeholder={t('settings.agentPromptPlaceholder')}
                onChange={(e) => updateAgent(agent.agentId, { prompt: e.target.value })}
              />
              <div className="hint">{t('settings.agentPromptHint')}</div>
              <div className="btns" style={{ marginTop: 8 }}>
                <button className="btn w" disabled={busy} onClick={() => saveAgentPrompt()}>
                  {t('common.save')}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
        </div>
      </div>

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
