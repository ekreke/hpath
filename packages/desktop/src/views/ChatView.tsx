// Chat / system status view. All messages — typed text and quick-query chips
// alike — go to the server-side LLM chat, which answers from a live snapshot
// of system state (configured in Settings); streamed text deltas render as
// markdown into a bot bubble. While streaming, a status line under the input
// shows live token metrics (model, up/down, elapsed) so the wait never looks
// stuck; exact provider usage lands on the bubble once the stream ends.
// Turns are persisted server-side per session: the header's session selector
// lists past conversations, the first question lazily creates a session, and
// deleting a session cascades server-side. Nothing is sent to the LLM until
// the user asks — the landing state is a plain welcome hint.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Select } from '../components/Select';
import {
  invokeChat,
  invokeCreateChatSession,
  invokeDeleteChatSession,
  invokeListChatMessages,
  invokeListChatSessions,
  type ChatEvent,
  type ChatMessage,
  type ChatSession,
} from '../lib/ipc';

type ChatViewProps = {
  onToast: (text: string, error?: boolean) => void;
};

type ChatMeta = {
  model?: string;
  promptTokensEst?: number;
  inputTokens?: number;
  outputTokens?: number;
  costTotal?: number;
  startedAt: number;
};

type Message = {
  id: number;
  role: 'user' | 'bot';
  text: string;
  streaming?: boolean;
  meta?: ChatMeta;
};

type LiveMetrics = {
  model?: string;
  promptTokensEst?: number;
  chars: number;
  startedAt: number;
};

let nextId = 1;

function formatMeta(meta: ChatMeta): string {
  const parts: string[] = [];
  if (meta.inputTokens !== undefined) parts.push(`↑${meta.inputTokens} tok`);
  else if (meta.promptTokensEst !== undefined) parts.push(`↑~${meta.promptTokensEst} tok`);
  if (meta.outputTokens !== undefined) parts.push(`↓${meta.outputTokens} tok`);
  parts.push(`${((Date.now() - meta.startedAt) / 1000).toFixed(1)}s`);
  if (meta.costTotal && meta.costTotal > 0) parts.push(`$${meta.costTotal.toFixed(4)}`);
  return parts.join(' · ');
}

/** Map a persisted assistant turn onto the bubble meta; zero usage stays
 * undefined so restored bubbles don't render "↑0 tok". Elapsed time counts
 * from the preceding user turn when one exists (real latency, not clock drift). */
function restoreMessages(rows: ChatMessage[]): Message[] {
  return rows.map((row, i) => {
    const isUser = row.role === 1;
    const meta: ChatMeta | undefined = isUser
      ? undefined
      : {
          inputTokens: row.inputTokens > 0 ? row.inputTokens : undefined,
          outputTokens: row.outputTokens > 0 ? row.outputTokens : undefined,
          costTotal: row.costTotal > 0 ? row.costTotal : undefined,
          startedAt:
            i > 0 && rows[i - 1].role === 1
              ? Date.parse(rows[i - 1].createdAt) || Date.parse(row.createdAt)
              : Date.parse(row.createdAt),
        };
    return { id: nextId++, role: isUser ? 'user' : 'bot', text: row.content, meta };
  });
}

function sessionLabel(session: ChatSession | undefined, untitled: string): string {
  if (!session) return untitled;
  return session.title || untitled;
}

function ChatView({ onToast }: ChatViewProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef<HTMLDivElement>(null);

  const push = useCallback((m: Message) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Tick the status line's elapsed time while a response is streaming.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [busy]);

  // Load past sessions once; land on the most recently active one so the
  // transcript survives tab switches and app restarts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await invokeListChatSessions();
        if (cancelled) return;
        setSessions(list);
        const first = list[0]?.id ?? null;
        setActiveSessionId(first);
        if (first) setMessages(restoreMessages(await invokeListChatMessages(first)));
      } catch (err) {
        if (!cancelled) onToast(String(err), true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) return;
      setActiveSessionId(sessionId);
      setMessages([]);
      try {
        setMessages(restoreMessages(await invokeListChatMessages(sessionId)));
      } catch (err) {
        onToast(String(err), true);
      }
    },
    [activeSessionId, onToast],
  );

  // Sessions are created lazily: the first question of an empty chat spins one
  // up, so the landing page never accumulates empty conversations.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (activeSessionId) return activeSessionId;
    try {
      const session = await invokeCreateChatSession('');
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      return session.id;
    } catch (err) {
      onToast(String(err), true);
      return null;
    }
  }, [activeSessionId, onToast]);

  const newSession = useCallback(async () => {
    try {
      const session = await invokeCreateChatSession('');
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
    } catch (err) {
      onToast(String(err), true);
    }
  }, [onToast]);

  const deleteSession = useCallback(async () => {
    if (!activeSessionId) return;
    const doomed = activeSessionId;
    try {
      await invokeDeleteChatSession(doomed);
      const remaining = sessions.filter((s) => s.id !== doomed);
      setSessions(remaining);
      setActiveSessionId(remaining[0]?.id ?? null);
      setMessages(
        remaining[0] ? restoreMessages(await invokeListChatMessages(remaining[0].id)) : [],
      );
      onToast(t('chat.sessionDeleted'));
    } catch (err) {
      onToast(String(err), true);
    }
  }, [activeSessionId, sessions, onToast, t]);

  // Free-text questions go to the server-side LLM chat: text deltas stream on
  // the `chat-event` channel and render as markdown into a single bot bubble.
  // The server persists both turns into the active session.
  const askModel = useCallback(
    async (text: string) => {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      push({ id: nextId++, role: 'user', text });
      setBusy(true);
      const meta: ChatMeta = { startedAt: Date.now() };
      setLive({ chars: 0, startedAt: meta.startedAt });
      const botId = nextId++;
      push({ id: botId, role: 'bot', text: '', streaming: true });
      const append = (patch: Partial<Message>) =>
        setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, ...patch } : m)));
      let active = true;
      const unlisten = await listen<ChatEvent>('chat-event', (e) => {
        if (!active) return;
        const ev = e.payload;
        if (ev.kind === 'textDelta') {
          setMessages((prev) =>
            prev.map((m) => (m.id === botId ? { ...m, text: m.text + ev.text } : m)),
          );
          setLive((prev) => (prev ? { ...prev, chars: prev.chars + ev.text.length } : prev));
        } else if (ev.kind === 'status') {
          meta.model = ev.model;
          meta.promptTokensEst = ev.promptTokensEst;
          setLive((prev) =>
            prev ? { ...prev, model: ev.model, promptTokensEst: ev.promptTokensEst } : prev,
          );
        } else if (ev.kind === 'usage') {
          meta.inputTokens = ev.inputTokens;
          meta.outputTokens = ev.outputTokens;
          meta.costTotal = ev.costTotal;
          append({ meta: { ...meta } });
        } else {
          append({
            streaming: false,
            text: `${t('chat.modelError')}: ${ev.message}`,
            meta: { ...meta },
          });
        }
      });
      try {
        await invokeChat(sessionId, text);
      } catch (err) {
        append({ streaming: false, text: String(err), meta: { ...meta } });
        onToast(String(err), true);
      } finally {
        active = false;
        unlisten();
        append({ streaming: false, meta: { ...meta } });
        setLive(null);
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [push, onToast, ensureSession],
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void askModel(text);
  };

  const liveElapsed = live ? ((now - live.startedAt) / 1000).toFixed(1) : null;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const untitledLabel = t('chat.untitledSession');

  return (
    <div className="page-inner chat">
      <div className="ph">
        <div>
          <h1>{t('chat.title')}</h1>
          <div className="path">{t('chat.subtitle')}</div>
        </div>
        <div className="btns">
          <Select
            value={activeSessionId}
            options={sessions.map((s) => ({ value: s.id, label: sessionLabel(s, untitledLabel) }))}
            onChange={(id) => void switchSession(id)}
            ariaLabel={t('chat.sessionLabel')}
            placeholder={t('chat.sessionEmpty')}
            disabled={busy}
          />
          <button className="btn sm" disabled={busy} onClick={() => void newSession()}>
            {t('chat.newSession')}
          </button>
          <button
            className="btn sm ghost"
            disabled={busy || !activeSessionId}
            onClick={() => void deleteSession()}
          >
            {t('chat.deleteSession')}
          </button>
        </div>
      </div>

      <div className="chat-thread">
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <span className="chat-avatar">{m.role === 'user' ? 'U' : '▲'}</span>
            <div className="chat-bubble">
              {m.role === 'bot' ? (
                <>
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.text || (m.streaming ? '…' : '')}
                    </ReactMarkdown>
                  </div>
                  {m.streaming && m.text ? <span className="dim cursor">▍</span> : null}
                  {!m.streaming && m.meta ? <div className="chat-meta">{formatMeta(m.meta)}</div> : null}
                </>
              ) : (
                <p>{m.text}</p>
              )}
            </div>
          </div>
        ))}
        {messages.length === 0 && <p className="hint">{t('chat.initialHint')}</p>}
        <div ref={endRef} />
      </div>

      <div className="chat-quick">
        {(
          [
            t('chat.qOverview'),
            t('chat.qRunning'),
            t('chat.qRecent'),
            t('chat.qHealth'),
            t('chat.qEnvs'),
          ] as string[]
        ).map((label) => (
          <button key={label} className="chip" disabled={busy} onClick={() => void askModel(label)}>
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

      {live && (
        <div className="chat-status" role="status">
          <span className="dot" />
          <span>
            {t('chat.generating')}
            {live.model ? ` · ${live.model}` : ''}
            {live.promptTokensEst !== undefined ? ` · ↑~${live.promptTokensEst} tok` : ''}
            {` · ↓${live.chars} chars`}
            {liveElapsed !== null ? ` · ${liveElapsed}s` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export default ChatView;
