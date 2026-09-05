// Per-case health strip: the last N runs of one case as status dots plus a
// passed/total count within the same window. Rendered inline in the case
// list (CasesView) so health sits at the same level as the case itself.
// Dots: hollow = passed, solid = failed (hover shows status + start time).
import { useTranslation } from 'react-i18next';
import type { Run } from '@hpath/contract';
import { RUN_STATUS, formatDateTime, runStatusKey, runTagVariant } from '../lib/status';

// Results shown per case in the health strip.
export const HEALTH_LAST_N = 10;

export function HealthStrip({ results }: { results: Run[] }) {
  const { t } = useTranslation();
  // Most recent first (callers pass runs sorted desc); both the dots and the
  // count cover the same recent window so the numbers never drift apart.
  const last = results.slice(0, HEALTH_LAST_N);
  const passed = last.filter((r) => r.status === RUN_STATUS.PASSED).length;
  return (
    <span className="hstrip">
      {last.map((r) => (
        <i
          key={r.id}
          className={`dot ${runTagVariant(r.status)}`}
          title={`${t(runStatusKey(r.status))} · ${formatDateTime(r.startedAt)}`}
        />
      ))}
      {last.length === 0 && <span className="dim">—</span>}
      {last.length > 0 && (
        <span className="dim num">
          {passed}/{last.length}
        </span>
      )}
    </span>
  );
}
