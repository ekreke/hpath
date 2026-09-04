// Top bar: breadcrumb only. The last segment is the current page; earlier
// segments may carry an onClick (e.g. "Projects" returns to the project
// list from inside a project workspace).
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

export type BreadcrumbSegment = {
  label: string;
  onClick?: () => void;
};

type TopBarProps = {
  segments: BreadcrumbSegment[];
};

function TopBar({ segments }: TopBarProps) {
  const { t } = useTranslation();

  return (
    <header className="tb">
      <nav className="crumb" aria-label={t('topbar.breadcrumb')}>
        {segments.map((seg, i) => {
          const last = i === segments.length - 1;
          return (
            <Fragment key={i}>
              {i > 0 && <span>/</span>}
              {seg.onClick && !last ? (
                <button className="crumb-link" onClick={seg.onClick}>
                  {seg.label}
                </button>
              ) : last ? (
                <b>{seg.label}</b>
              ) : (
                <span>{seg.label}</span>
              )}
            </Fragment>
          );
        })}
      </nav>
    </header>
  );
}

export default TopBar;
