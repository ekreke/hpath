// Left sidebar: brand (with collapse toggle), the three top-level
// destinations (chat / projects / settings), and the connection footer.
// Project selection lives in the Projects page; env selection in the Cases
// view run panel.
import { useTranslation } from 'react-i18next';

export type ViewId = 'chat' | 'projects' | 'settings';

type SidebarProps = {
  view: ViewId;
  connectionStatus: 'connected' | 'connecting' | 'offline';
  serverAddr: string;
  sidebarOpen: boolean;
  onSelectView: (view: ViewId) => void;
  onToggleSidebar: () => void;
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

function IconProjects() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 1.8 13.8 5v6L8 14.2 2.2 11V5z" />
      <path d="M2.2 5 8 8.2 13.8 5" />
      <path d="M8 8.2v6" />
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

function IconPanel() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

const BRAND_TEXT = 'HappyPath';
const BRAND_STYLES = ['hc-1', 'hc-w', 'hc-w', 'hc-w', 'hc-w', 'hc-7', 'hc-6', 'hc-8', 'hc-5'];

function BrandRainbow() {
  return (
    <span className="brand-name">
      {Array.from(BRAND_TEXT).map((ch, i) => (
        <span key={i} className={BRAND_STYLES[i]}>
          {ch}
        </span>
      ))}
    </span>
  );
}

function Sidebar({
  view,
  connectionStatus,
  serverAddr,
  sidebarOpen,
  onSelectView,
  onToggleSidebar,
}: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="sb">
      <div className="brand">
        <BrandRainbow />
        <button
          className="btn sm ghost brand-toggle"
          aria-label={t(sidebarOpen ? 'sidebar.collapse' : 'sidebar.expand')}
          title={t(sidebarOpen ? 'sidebar.collapse' : 'sidebar.expand')}
          onClick={onToggleSidebar}
        >
          <IconPanel />
        </button>
      </div>

      <nav className="nav">
        <button className={view === 'chat' ? 'itm on' : 'itm'} onClick={() => onSelectView('chat')}>
          <IconChat />
          {t('sidebar.chat')}
        </button>
        <button
          className={view === 'projects' ? 'itm on' : 'itm'}
          onClick={() => onSelectView('projects')}
        >
          <IconProjects />
          {t('sidebar.projects')}
        </button>
        <button
          className={view === 'settings' ? 'itm on' : 'itm'}
          onClick={() => onSelectView('settings')}
        >
          <IconSettings />
          {t('sidebar.settings')}
        </button>
      </nav>

      <div className="sbfoot">
        <i className={connectionStatus === 'connected' ? 'ok' : connectionStatus === 'connecting' ? 'warn' : 'err'} />
        {t(`topbar.${connectionStatus}`)} · {serverAddr}
      </div>
    </aside>
  );
}

export default Sidebar;
