// Left sidebar: brand, project switcher (+ create), view navigation, connection footer.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../lib/ipc';
import { invokeCreateProject } from '../lib/ipc';

export type ViewId = 'chat' | 'cases' | 'history' | 'envs' | 'prd' | 'settings';

type SidebarProps = {
  projects: Project[];
  selectedProjectId: string | null;
  view: ViewId;
  connectionStatus: 'connected' | 'connecting' | 'offline';
  serverAddr: string;
  caseCount: number;
  envCount: number;
  onSelectProject: (id: string | null) => void;
  onSelectView: (view: ViewId) => void;
  onProjectCreated: (id: string) => void;
  onToast: (text: string, error?: boolean) => void;
};

function IconChat() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 3.5h12v8H5.5L2 13.5z" />
      <circle cx="5.4" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconCases() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M5 3.5h9M5 8h9M5 12.5h9" />
      <circle cx="2.2" cy="3.5" r="1" />
      <circle cx="2.2" cy="8" r="1" />
      <circle cx="2.2" cy="12.5" r="1" />
    </svg>
  );
}

function IconEnvs() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="4.5" rx="1" />
      <rect x="2" y="9" width="12" height="4.5" rx="1" />
      <circle cx="4.6" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="4.6" cy="11.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconPrd() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13" />
    </svg>
  );
}

function IconRuns() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
    </svg>
  );
}

function Sidebar({
  projects,
  selectedProjectId,
  view,
  connectionStatus,
  serverAddr,
  caseCount,
  envCount,
  onSelectProject,
  onSelectView,
  onProjectCreated,
  onToast,
}: SidebarProps) {
  const { t } = useTranslation();
  const selected = projects.find((p) => p.id === selectedProjectId);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const openCreate = () => {
    setName('');
    setRepoUrl('');
    setCreateOpen(true);
  };

  const save = async () => {
    if (!name.trim()) {
      onToast(t('sidebar.projectNameRequired'), true);
      return;
    }
    setBusy(true);
    try {
      const created = await invokeCreateProject(name.trim(), repoUrl.trim());
      setCreateOpen(false);
      onProjectCreated(created.id);
      onToast(t('sidebar.projectCreated', { name: created.name }));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sb">
      <div className="brand">
        <span style={{ fontSize: 12, transform: 'translateY(-1px)' }}>▲</span>
        HPath
        <em>desktop</em>
      </div>

      <div className="proj">
        <div className="prow">
          <select
            aria-label={t('sidebar.project')}
            value={selectedProjectId ?? ''}
            onChange={(e) => onSelectProject(e.target.value || null)}
          >
            <option value="">{t('sidebar.selectProject')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="btn sm ghost"
            aria-label={t('sidebar.createProject')}
            title={t('sidebar.createProject')}
            onClick={openCreate}
          >
            ＋
          </button>
        </div>
        <div className="s">
          {selected ? selected.repoUrl || selected.id.slice(0, 8) : serverAddr}
        </div>
      </div>

      <nav className="nav">
        <div className="g">{t('sidebar.groupWorkbench')}</div>
        <button className={view === 'chat' ? 'itm on' : 'itm'} onClick={() => onSelectView('chat')}>
          <IconChat />
          {t('sidebar.chat')}
        </button>
        <button className={view === 'cases' ? 'itm on' : 'itm'} onClick={() => onSelectView('cases')}>
          <IconCases />
          {t('sidebar.cases')}
          <span className="ct">{caseCount}</span>
        </button>
        <button
          className={view === 'history' ? 'itm on' : 'itm'}
          onClick={() => onSelectView('history')}
        >
          <IconRuns />
          {t('sidebar.runHistory')}
        </button>
        <button className={view === 'prd' ? 'itm on' : 'itm'} onClick={() => onSelectView('prd')}>
          <IconPrd />
          {t('sidebar.prdDocs')}
        </button>
        <div className="g">{t('sidebar.groupConfig')}</div>
        <button className={view === 'envs' ? 'itm on' : 'itm'} onClick={() => onSelectView('envs')}>
          <IconEnvs />
          {t('sidebar.envs')}
          <span className="ct">{envCount}</span>
        </button>
      </nav>

      <div className="sb-settings">
        <button
          className={view === 'settings' ? 'itm on' : 'itm'}
          onClick={() => onSelectView('settings')}
        >
          <IconSettings />
          {t('sidebar.settings')}
        </button>
      </div>

      <div className="sbfoot">
        <i className={connectionStatus === 'connected' ? 'ok' : connectionStatus === 'connecting' ? 'warn' : 'err'} />
        {t(`topbar.${connectionStatus}`)} · {serverAddr}
      </div>

      {createOpen && (
        <div className="overlay" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('sidebar.createProjectTitle')}</h3>
            <div className="field">
              <label>{t('sidebar.projectName')}</label>
              <input
                autoFocus
                value={name}
                placeholder="demo-bank"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                }}
              />
            </div>
            <div className="field">
              <label>{t('sidebar.repoUrl')}</label>
              <input
                value={repoUrl}
                placeholder="https://github.com/example/demo-bank"
                onChange={(e) => setRepoUrl(e.target.value)}
              />
            </div>
            <div className="mfoot">
              <button className="btn ghost" onClick={() => setCreateOpen(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn w" disabled={busy} onClick={() => void save()}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;
