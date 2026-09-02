// Chat / system status view (T17). Default landing page: a conversational
// interface that answers questions about system state by aggregating the
// existing gRPC endpoints through the IPC surface. Client-side only in 1.0 —
// the server-side status-agent (natural-language over the same data) is
// reserved for 1.1. The Rust side holds the server address, so no command
// here carries an addr argument.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Case, Env, Run } from '@hpath/contract';
import { invokeListCases, invokeListEnvs, invokeListRuns } from '../lib/ipc';
import { CaseStatusBadge, RunStatusTag } from '../components/Ui';
import {
  CASE_STATUS,
  RUN_STATUS,
  formatDuration,
  formatTime,
  sortRunsDesc,
} from '../lib/status';

type ChatViewProps = {
  projectId: string | null;
  envs: Env[];
  onToast: (text: string, error?: boolean) => void;
};

type Query = 'overview' | 'running' | 'recent' | 'health' | 'envs' | 'help';

type Message = {
  id: number;
  role: 'user' | 'bot';
  text: string;
  kind?: Query;
  cases?: Case[];
  runs?: Run[];
  envs?: Env[];
  counts?: { approved: number; pending: number; disabled: number; drafts: number };
  health?: { caseId: string; title: string; results: Run[] }[];
};

let nextId = 1;

function quickQueryFor(input: string): Query | null {
  const s = input.toLowerCase();
  // "recent" phrasings usually contain "run(s)" / "运行" too, so they must be
  // checked before the running pattern or they get shadowed.
  if (/(recent|最近|latest|历史)/.test(s)) return 'recent';
  if (/(run|running|任务|运行|正在)/.test(s)) return 'running';
  if (/(health|健康|通过率|pass)/.test(s)) return 'health';
  if (/(env|环境)/.test(s)) return 'envs';
  if (/(overview|status|状态|概览|总览|情况)/.test(s)) return 'overview';
  return null;
}

function BotMessage({ msg, envs }: { msg: Message; envs: Env[] }) {
  const { t } = useTranslation();
  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  if (msg.kind === 'overview' && msg.counts) {
    const runs = msg.runs ?? [];
    const summary = runs.length
      ? t('chat.runSummary', {
          total: runs.length,
          passed: runs.filter((r) => r.status === RUN_STATUS.PASSED).length,
          failed: runs.filter((r) => r.status === RUN_STATUS.FAILED).length,
          running: runs.filter((r) => r.status === RUN_STATUS.RUNNING).length,
        })
      : t('chat.noRuns');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '4px 8px' }}>
          <div className="k">{t('chat.casesApproved')}</div>
          <div className="v"><CaseStatusBadge status={CASE_STATUS.APPROVED} /> × {msg.counts.approved}</div>
          <div className="k">{t('chat.casesPending')}</div>
          <div className="v"><CaseStatusBadge status={CASE_STATUS.PENDING} /> × {msg.counts.pending}</div>
          <div className="k">{t('chat.casesDrafts')}</div>
          <div className="v">{t('chat.casesDraftsVal', { n: msg.counts.drafts })}</div>
          <div className="k">{t('chat.casesDisabled')}</div>
          <div className="v">{t('chat.casesDisabledVal', { n: msg.counts.disabled })}</div>
        </div>
        <div className="hint">{summary}</div>
      </div>
    );
  }

  if (msg.kind === 'health' && msg.health) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {msg.health.map((h) => {
          const total = h.results.length;
          return (
            <div key={h.caseId} className="kv" style={{ gridTemplateColumns: '1fr auto', gap: '4px 8px' }}>
              <div className="v" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {h.title}
              </div>
              <div style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                {h.results.slice(0, 5).map((r) => <RunStatusTag key={r.id} status={r.status} />)}
                {total > 5 && <span className="dim num">{total}</span>}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if ((msg.kind === 'recent' || msg.kind === 'running') && msg.runs) {
    if (msg.runs.length === 0) {
      return <p className="hint">{msg.kind === 'running' ? t('chat.noRunning') : t('chat.noRuns')}</p>;
    }
    const caseTitle = (id: string) =>
      msg.cases?.find((c) => c.id === id)?.title ?? id.slice(0, 8);
    return (
      <table>
        <thead>
          <tr>
            <th>{t('runs.colTime')}</th>
            <th>{t('cases.colCase')}</th>
            <th>{t('runs.colEnv')}</th>
            <th>{t('runs.colResult')}</th>
            <th className="num">{t('runs.colDuration')}</th>
          </tr>
        </thead>
        <tbody>
          {msg.runs.map((r) => (
            <tr key={r.id}>
              <td className="dim num">{formatTime(r.startedAt, t)}</td>
              <td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {caseTitle(r.caseId)}
              </td>
              <td className="dim">{envName(r.envId)}</td>
              <td><RunStatusTag status={r.status} /></td>
              <td className="num">{formatDuration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (msg.kind === 'envs' && msg.envs) {
    if (msg.envs.length === 0) {
      return <p className="hint">{t('chat.noEnvs')}</p>;
    }
    return (
      <table>
        <thead>
          <tr>
            <th>{t('envs.colName')}</th>
            <th>{t('envs.colWeb')}</th>
            <th>{t('envs.colGrpc')}</th>
            <th className="num">{t('envs.colVars')}</th>
          </tr>
        </thead>
        <tbody>
          {msg.envs.map((e) => (
            <tr key={e.id}>
              <td className="mono">{e.name}</td>
              <td className="mono dim">{e.webBaseUrl || '—'}</td>
              <td className="mono dim">{e.grpcAddress || '—'}</td>
              <td className="num">{Object.keys(e.vars ?? {}).length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return <p>{msg.text}</p>;
}

function ChatView({ projectId, envs, onToast }: ChatViewProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const push = useCallback((m: Message) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const runQuery = useCallback(
    async (query: Query, label?: string) => {
      if (label) push({ id: nextId++, role: 'user', text: label });
      if (!projectId) {
        push({ id: nextId++, role: 'bot', text: t('common.selectProjectFirst') });
        return;
      }
      setBusy(true);
      try {
        if (query === 'overview') {
          const [caseList, runList] = await Promise.all([
            invokeListCases(projectId),
            invokeListRuns(projectId),
          ]);
          push({
            id: nextId++,
            role: 'bot',
            text: t('chat.overviewDone'),
            kind: 'overview',
            counts: {
              approved: caseList.filter((c) => c.status === CASE_STATUS.APPROVED).length,
              pending: caseList.filter((c) => c.status === CASE_STATUS.PENDING).length,
              drafts: caseList.filter((c) => c.status === CASE_STATUS.DRAFT).length,
              disabled: caseList.filter((c) => c.status === CASE_STATUS.DISABLED).length,
            },
            runs: runList,
          });
        } else if (query === 'running') {
          const [runList, caseList] = await Promise.all([
            invokeListRuns(projectId, { status: RUN_STATUS.RUNNING }),
            invokeListCases(projectId),
          ]);
          push({
            id: nextId++,
            role: 'bot',
            text: t('chat.runningDone'),
            kind: 'running',
            runs: sortRunsDesc(runList),
            cases: caseList,
          });
        } else if (query === 'recent') {
          const [runList, caseList] = await Promise.all([
            invokeListRuns(projectId),
            invokeListCases(projectId),
          ]);
          push({
            id: nextId++,
            role: 'bot',
            text: t('chat.recentDone'),
            kind: 'recent',
            runs: sortRunsDesc(runList).slice(0, 10),
            cases: caseList,
          });
        } else if (query === 'health') {
          const [caseList, runList] = await Promise.all([
            invokeListCases(projectId),
            invokeListRuns(projectId),
          ]);
          push({
            id: nextId++,
            role: 'bot',
            text: t('chat.healthDone'),
            kind: 'health',
            health: caseList.map((c) => ({
              caseId: c.id,
              title: c.title,
              results: sortRunsDesc(runList.filter((r) => r.caseId === c.id)),
            })),
          });
        } else if (query === 'envs') {
          const list = await invokeListEnvs(projectId);
          push({
            id: nextId++,
            role: 'bot',
            text: t('chat.envsDone'),
            kind: 'envs',
            envs: list,
          });
        } else {
          push({ id: nextId++, role: 'bot', text: t('chat.help') });
        }
      } catch (err) {
        push({ id: nextId++, role: 'bot', text: String(err) });
        onToast(String(err), true);
      } finally {
        setBusy(false);
      }
    },
    [projectId, push, onToast, t],
  );

  // Auto-answer the overview on first render so the landing page is useful
  // without any input.
  useEffect(() => {
    if (projectId) void runQuery('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const query = quickQueryFor(text);
    if (query) {
      void runQuery(query, text);
    } else {
      push({ id: nextId++, role: 'user', text });
      push({ id: nextId++, role: 'bot', text: t('chat.help') });
    }
  };

  return (
    <div className="page-inner chat">
      <div className="ph">
        <div>
          <h1>
            {t('chat.title')} <span className="pill">{t('app.mock')}</span>
          </h1>
          <div className="path">{t('chat.subtitle')}</div>
        </div>
      </div>

      <div className="chat-thread">
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <span className="chat-avatar">{m.role === 'user' ? 'U' : '▲'}</span>
            <div className="chat-bubble">
              <BotMessage msg={m} envs={envs} />
            </div>
          </div>
        ))}
        {messages.length === 0 && <p className="hint">{t('chat.initialHint')}</p>}
        <div ref={endRef} />
      </div>

      <div className="chat-quick">
        {(
          [
            ['overview', t('chat.qOverview')],
            ['running', t('chat.qRunning')],
            ['recent', t('chat.qRecent')],
            ['health', t('chat.qHealth')],
            ['envs', t('chat.qEnvs')],
          ] as [Query, string][]
        ).map(([q, label]) => (
          <button key={q} className="chip" disabled={busy} onClick={() => void runQuery(q, label)}>
            {label}
          </button>
        ))}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <input
          value={input}
          placeholder={t('chat.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button className="btn w" type="submit" disabled={busy || !input.trim()}>
          {t('chat.send')}
        </button>
      </form>
    </div>
  );
}

export default ChatView;
