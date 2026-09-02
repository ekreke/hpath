// Small shared presentational helpers (Geist-style tags, badges, toasts).
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  caseStatusKey,
  runStatusKey,
  runTagVariant,
} from '../lib/status';

export function CaseStatusBadge({ status }: { status: number }) {
  const { t } = useTranslation();
  return <span className="badge">{t(caseStatusKey(status))}</span>;
}

export function RunStatusTag({ status }: { status: number }) {
  const { t } = useTranslation();
  const variant = runTagVariant(status);
  const cls = variant === 'muted' ? 'tag' : `tag ${variant}`;
  return (
    <span className={cls}>
      <i />
      {t(runStatusKey(status))}
    </span>
  );
}

export function Toast({ text, error, onDone }: { text: string; error?: boolean; onDone: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(id);
  }, [text, onDone]);
  return <div className={error ? 'toast err' : 'toast'}>{text}</div>;
}
