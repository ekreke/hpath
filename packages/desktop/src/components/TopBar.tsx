// Top bar: breadcrumb, env segment switcher. Server address and language
// moved to the Settings view (models / server / general sub-tabs).
import { useTranslation } from 'react-i18next';
import type { Env } from '../lib/ipc';

type TopBarProps = {
  projectName: string | null;
  viewLabel: string;
  envs: Env[];
  selectedEnvId: string | null;
  onSelectEnv: (id: string | null) => void;
};

function TopBar({ projectName, viewLabel, envs, selectedEnvId, onSelectEnv }: TopBarProps) {
  const { t } = useTranslation();

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
      </div>
    </header>
  );
}

export default TopBar;
