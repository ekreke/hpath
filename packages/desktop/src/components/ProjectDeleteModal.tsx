// Danger-zone confirmation for deleting a project and everything under it
// (envs, cases, runs, PRDs, artifact files). The delete button stays disabled
// until the user types the project name exactly.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@hpath/contract';
import { invokeDeleteProject, toFriendlyError } from '../lib/ipc';

type ProjectDeleteModalProps = {
  project: Project;
  onDeleted: (projectId: string) => void;
  onClose: () => void;
  onToast: (text: string, error?: boolean) => void;
};

function ProjectDeleteModal({ project, onDeleted, onClose, onToast }: ProjectDeleteModalProps) {
  const { t } = useTranslation();
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const armed = confirmText.trim() === project.name;

  const confirm = async () => {
    if (!armed || busy) return;
    setBusy(true);
    try {
      await invokeDeleteProject(project.id);
      onToast(t('projects.deleted', { name: project.name }));
      onDeleted(project.id);
    } catch (err) {
      onToast(toFriendlyError(err).message, true);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('projects.deleteTitle')}</h3>
        <p className="hint" style={{ marginBottom: 12 }}>{t('projects.deleteHint')}</p>
        <div className="field">
          <label>{t('projects.deleteConfirmLabel')}</label>
          <input
            autoFocus
            value={confirmText}
            placeholder={project.name}
            onChange={(e) => setConfirmText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirm();
            }}
          />
        </div>
        <div className="mfoot">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn danger" disabled={!armed || busy} onClick={() => void confirm()}>
            {busy ? t('projects.deleting') : t('projects.deleteProject')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ProjectDeleteModal;
