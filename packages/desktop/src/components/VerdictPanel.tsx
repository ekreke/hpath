// Verdict display: status + summary + three-way alignment evidence table.
// Shared by the live run panel and (historically) the case detail view.
import { useTranslation } from 'react-i18next';
import type { Verdict } from '@hpath/contract';
import { VERDICT_STATUS } from '../lib/status';

function VerdictPanel({ verdict }: { verdict: Verdict }) {
  const { t } = useTranslation();
  const key =
    verdict.status === VERDICT_STATUS.PASSED
      ? 'status.verdictPassed'
      : verdict.status === VERDICT_STATUS.FAILED
        ? 'status.verdictFailed'
        : 'status.verdictInconclusive';
  return (
    <div>
      <div className="panelh">
        <span>{t('cases.verdict')}</span>
        <b>{t(key)}</b>
      </div>
      <div className="mono-block">
        <div className="t">{verdict.summary}</div>
      </div>
      {verdict.evidence.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('cases.evApiPath')}</th>
              <th>{t('cases.evApiObserved')}</th>
              <th>{t('cases.evUiAnchor')}</th>
              <th>{t('cases.evUiObserved')}</th>
              <th>{t('cases.evMatch')}</th>
            </tr>
          </thead>
          <tbody>
            {verdict.evidence.map((e, i) => (
              <tr key={i}>
                <td className="mono">{e.apiPath}</td>
                <td className="mono dim" style={{ whiteSpace: 'normal' }}>{e.apiObserved}</td>
                <td className="dim">{e.uiAnchor}</td>
                <td className="mono dim" style={{ whiteSpace: 'normal' }}>{e.uiObserved}</td>
                <td>
                  <span className={e.match ? 'tag pass' : 'tag fail'}>
                    <i />
                    {e.match ? 'MATCH' : 'MISMATCH'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default VerdictPanel;
