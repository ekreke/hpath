// Project detail panel inside the workspace: project metadata, an edit form
// (name + repo URL) and the danger zone that opens the cascade-delete
// confirmation.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@hpath/contract';
import { invokeUpdateProject, toFriendlyError } from '../lib/ipc';
import ProjectDeleteModal from './ProjectDeleteModal';

type ProjectDetailPanelProps = {
  project: Project;
  onRenamed: (project: Project) => void;
  onDeleted: (projectId: string) => void;
  onToast: (text: string, error?: boolean) => void;
};

function ProjectDetailPanel({ project, onRenamed, onDeleted, onToast }: ProjectDetailPanelProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(project.name);
  const [repoUrl, setRepoUrl] = useState(project.repoUrl);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const dirty = name !== project.name || repoUrl !== project.repoUrl;
  const valid = name.trim() !== '';

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const saved = await invokeUpdateProject(project.id, name.trim(), repoUrl.trim());
      onRenamed(saved);
      onToast(t('projects.saved'));
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
            {t('projects.detail')}
            <span className="pill">{project.name}</span>
          </h1>
        </div>
      </div>

      <section className="sec">
        <div className="shead">
          <h2>{t('projects.editTitle')}</h2>
        </div>
        <div className="field" style={{ maxWidth: 480 }}>
          <label>{t('projects.colName')}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </div>
        <div className="field" style={{ maxWidth: 480 }}>
          <label>{t('projects.colRepo')}</label>
          <input
            value={repoUrl}
            placeholder="https://github.com/example/demo-bank"
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </div>
        <div className="btns">
          <button className="btn w" disabled={busy || !dirty || !valid} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </section>

      <section className="sec">
        <div className="shead">
          <h2>{t('projects.dangerZone')}</h2>
        </div>
        <div className="panelbox" style={{ maxWidth: 480 }}>
          <div style={{ padding: '14px 16px' }}>
            <p className="hint" style={{ marginBottom: 12 }}>{t('projects.deleteHint')}</p>
            <button className="btn danger" onClick={() => setDeleteOpen(true)}>
              {t('projects.deleteProject')}
            </button>
          </div>
        </div>
      </section>

      {deleteOpen && (
        <ProjectDeleteModal
          project={project}
          onDeleted={onDeleted}
          onClose={() => setDeleteOpen(false)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

export default ProjectDetailPanel;
