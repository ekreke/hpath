// Create/edit modal for manual cases: title, goal and three-way alignment
// rows. Persists via CreateCase when `kase` is null (lands in PENDING review
// status) or UpdateCase for an existing unapproved case.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Case } from '@hpath/contract';
import { invokeCreateCase, invokeUpdateCase, type CaseFormInput } from '../lib/ipc';

type AlignmentRow = { apiPath: string; uiAnchor: string; rule: string };

type CaseFormModalProps = {
  projectId: string;
  /** null = create; otherwise the case being edited. */
  kase: Case | null;
  onSaved: (kase: Case) => void;
  onClose: () => void;
  onToast: (text: string, error?: boolean) => void;
};

function CaseFormModal({ projectId, kase, onSaved, onClose, onToast }: CaseFormModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(kase?.title ?? '');
  const [goal, setGoal] = useState(kase?.goal ?? '');
  const [alignments, setAlignments] = useState<AlignmentRow[]>(
    kase?.alignments?.length
      ? kase.alignments.map((a) => ({ apiPath: a.apiPath, uiAnchor: a.uiAnchor, rule: a.rule }))
      : [],
  );
  const [busy, setBusy] = useState(false);

  const setRow = (idx: number, patch: Partial<AlignmentRow>) =>
    setAlignments((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)));

  const save = async () => {
    if (!title.trim()) {
      onToast(t('cases.titleRequired'), true);
      return;
    }
    if (!goal.trim()) {
      onToast(t('cases.goalRequired'), true);
      return;
    }
    // Drop fully empty rows so stray clicks never create junk alignments.
    const input: CaseFormInput = {
      title: title.trim(),
      goal: goal.trim(),
      alignments: alignments
        .map((a) => ({ apiPath: a.apiPath.trim(), uiAnchor: a.uiAnchor.trim(), rule: a.rule.trim() }))
        .filter((a) => a.apiPath || a.uiAnchor || a.rule),
    };
    setBusy(true);
    try {
      const saved = kase
        ? await invokeUpdateCase(kase.id, input)
        : await invokeCreateCase(projectId, input);
      onSaved(saved);
      onToast(t(kase ? 'cases.saved' : 'cases.created'));
    } catch (err) {
      onToast(String(err), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t(kase ? 'cases.editTitle' : 'cases.createTitle')}</h3>
        <div className="field">
          <label>{t('cases.colCase')}</label>
          <input
            autoFocus
            value={title}
            placeholder={t('cases.titlePlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label>{t('cases.goal')}</label>
          <textarea
            rows={3}
            value={goal}
            placeholder={t('cases.goalPlaceholder')}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>
        <div className="field">
          <label>{t('cases.alignments')}</label>
          {alignments.map((row, idx) => (
            <div
              key={idx}
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr auto', gap: 8, marginBottom: 8 }}
            >
              <input
                value={row.apiPath}
                placeholder={t('cases.evApiPath')}
                onChange={(e) => setRow(idx, { apiPath: e.target.value })}
              />
              <input
                value={row.uiAnchor}
                placeholder={t('cases.evUiAnchor')}
                onChange={(e) => setRow(idx, { uiAnchor: e.target.value })}
              />
              <input
                value={row.rule}
                placeholder={t('cases.colRule')}
                onChange={(e) => setRow(idx, { rule: e.target.value })}
              />
              <button
                className="btn ghost sm"
                aria-label={t('cases.removeAlignment')}
                onClick={() => setAlignments((prev) => prev.filter((_, i) => i !== idx))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn sm"
            onClick={() => setAlignments((prev) => [...prev, { apiPath: '', uiAnchor: '', rule: '' }])}
          >
            + {t('cases.addAlignment')}
          </button>
        </div>
        <div className="mfoot">
          <button className="btn ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn w" disabled={busy} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CaseFormModal;
