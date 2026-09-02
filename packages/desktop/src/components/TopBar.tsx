// Top bar: breadcrumb, env segment switcher, server address, language toggle.
import { useTranslation } from 'react-i18next';
import type { Env } from '../lib/ipc';

type TopBarProps = {
  projectName: string | null;
  viewLabel: string;
  envs: Env[];
  selectedEnvId: string | null;
  serverAddr: string;
  onSelectEnv: (id: string | null) => void;
  onServerAddrChange: (addr: string) => void;
  onApply: () => void;
};

function TopBar({
  projectName,
  viewLabel,
  envs,
  selectedEnvId,
  serverAddr,
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
    <header className="tb">
      <div className="crumb">
        {projectName ?? t('topbar.noProject')} <span>/</span> <b>{viewLabel}</b>
      </div>
      <div className="right">
        <div className="seg" aria-label={t('sidebar.env')}>
          <button
            className={!selectedEnvId ? 'on' : ''}
            onClick={() => onSelectEnv(null)}
          >
            {t('topbar.allEnvs')}
          </button>
          {envs.map((env) => (
            <button
              key={env.id}
              className={selectedEnvId === env.id ? 'on' : ''}
              onClick={() => onSelectEnv(env.id)}
            >
              {env.name}
            </button>
          ))}
        </div>
        <input
          className="inline-input"
          style={{ width: 170 }}
          aria-label={t('topbar.serverAddress')}
          value={serverAddr}
          onChange={(e) => onServerAddrChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApply();
          }}
        />
        <button className="btn sm ghost" onClick={onApply}>
          {t('topbar.apply')}
        </button>
        <button className="btn sm ghost" onClick={toggleLanguage}>
          {t('topbar.language')}
        </button>
      </div>
    </header>
  );
}

export default TopBar;
