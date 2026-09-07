// Projects view: the entry-level project list (search + create + clickable
// rows). Opening a row selects the project and shows its workspace
// (cases / history / PRD / envs).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@hpath/contract';
import { invokeCreateProject, toFriendlyError } from '../lib/ipc';
import ProjectDeleteModal from '../components/ProjectDeleteModal';

type ProjectsViewProps = {
  projects: Project[];
  onOpened: (projectId: string) => void;
  onCreated: (projectId: string) => void;
  onDeleted: (projectId: string) => void;
  onToast: (text: string, error?: boolean) => void;
};

function ProjectsView({ projects, onOpened, onCreated, onDeleted, onToast }: ProjectsViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = projects.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || (p.repoUrl ?? '').toLowerCase().includes(q);
  });

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
      onCreated(created.id);
      onToast(t('sidebar.projectCreated', { name: created.name }));
    } catch (err) {
      onToast(toFriendlyError(err).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-inner">
      <div className="ph">
        <div>
          <h1>
            {t('projects.title')}
            <span className="pill">{projects.length}</span>
          </h1>
          <div className="path">{t('projects.subtitle')}</div>
        </div>
        <div className="btns">
          <button className="btn w" onClick={openCreate}>
            ＋ {t('projects.newProject')}
          </button>
        </div>
      </div>

      <div className="filters">
        <input
          style={{ width: 280 }}
          value={query}
          placeholder={t('projects.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty">{projects.length === 0 ? t('projects.empty') : t('projects.noMatch')}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('projects.colName')}</th>
              <th>{t('projects.colRepo')}</th>
              <th className="num">{t('projects.colCreated')}</th>
              <th style={{ width: 60 }} aria-label={t('projects.deleteProject')} />
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => onOpened(p.id)}>
                <td>{p.name}</td>
                <td className="dim mono">{p.repoUrl || '—'}</td>
                <td className="num">
                  {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}
                </td>
                <td className="num">
                  <button
                    className="btn sm ghost"
                    aria-label={`${t('projects.deleteProject')}: ${p.name}`}
                    title={t('projects.deleteProject')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(p);
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deleteTarget && (
        <ProjectDeleteModal
          project={deleteTarget}
          onDeleted={onDeleted}
          onClose={() => setDeleteTarget(null)}
          onToast={onToast}
        />
      )}

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
    </div>
  );
}

export default ProjectsView;
