import { useTranslation } from 'react-i18next';

type Project = {
  id: string;
  name: string;
};

type Env = {
  id: string;
  name: string;
};

type ConnectionStatus = 'connected' | 'connecting' | 'offline';

type TopBarProps = {
  projects: Project[];
  envs: Env[];
  selectedProjectId: string | null;
  selectedEnvId: string | null;
  connectionStatus: ConnectionStatus;
  serverAddr: string;
  onSelectProject: (id: string | null) => void;
  onSelectEnv: (id: string | null) => void;
  onServerAddrChange: (addr: string) => void;
  onApply: () => void;
};

function TopBar({
  projects,
  envs,
  selectedProjectId,
  selectedEnvId,
  connectionStatus,
  serverAddr,
  onSelectProject,
  onSelectEnv,
  onServerAddrChange,
  onApply,
}: TopBarProps) {
  const { t, i18n } = useTranslation();

  const toggleLanguage = () => {
    const next = i18n.language === 'en' ? 'zh' : 'en';
    i18n.changeLanguage(next);
    localStorage.setItem('hpath.lang', next);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0.5rem 1rem',
        borderBottom: '1px solid #e5e7eb',
        background: '#f9fafb',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <label htmlFor="project-select">{t('topbar.project')}</label>
        <select
          id="project-select"
          value={selectedProjectId ?? ''}
          onChange={(e) => onSelectProject(e.target.value || null)}
        >
          <option value="">--</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label htmlFor="env-select">{t('topbar.env')}</label>
        <select
          id="env-select"
          value={selectedEnvId ?? ''}
          onChange={(e) => onSelectEnv(e.target.value || null)}
          disabled={!selectedProjectId}
        >
          <option value="">--</option>
          {envs.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
            padding: '0.25rem 0.5rem',
            borderRadius: '9999px',
            fontSize: '0.75rem',
            fontWeight: 500,
            background:
              connectionStatus === 'connected'
                ? '#dcfce7'
                : connectionStatus === 'connecting'
                  ? '#fef9c3'
                  : '#fee2e2',
            color:
              connectionStatus === 'connected'
                ? '#166534'
                : connectionStatus === 'connecting'
                  ? '#854d0e'
                  : '#991b1b',
          }}
        >
          {connectionStatus === 'connected'
            ? t('topbar.connected')
            : connectionStatus === 'connecting'
              ? t('topbar.connecting')
              : t('topbar.offline')}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button onClick={toggleLanguage} style={{ cursor: 'pointer' }}>
          {t('topbar.language')}
        </button>

        <label htmlFor="server-addr" style={{ marginLeft: '0.5rem' }}>
          {t('topbar.serverAddress')}
        </label>
        <input
          id="server-addr"
          value={serverAddr}
          onChange={(e) => onServerAddrChange(e.target.value)}
        />
        <button onClick={onApply}>{t('topbar.apply')}</button>
      </div>
    </div>
  );
}

export default TopBar;
