// Top bar: breadcrumb only. Env selection lives in the sidebar env tree
// (project → env hierarchy); server address and language in Settings.
import { useTranslation } from 'react-i18next';

type TopBarProps = {
  projectName: string | null;
  viewLabel: string;
};

function TopBar({ projectName, viewLabel }: TopBarProps) {
  const { t } = useTranslation();

  return (
    <header className="tb">
      <div className="crumb">
        {projectName ?? t('topbar.noProject')} <span>/</span> <b>{viewLabel}</b>
      </div>
    </header>
  );
}

export default TopBar;
