// Chat / system status view. All messages — typed text and quick-query chips
// alike — go to the server-side LLM chat, which answers from a live snapshot
// of system state (configured in Settings); streamed text deltas render as
// markdown into a bot bubble. While streaming, a status line under the input
// shows live token metrics (model, up/down, elapsed) so the wait never looks
// stuck; exact provider usage lands on the bubble once the stream ends.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invokeChat, type ChatEvent } from '../lib/ipc';

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
// ChatView remounts on every tab switch; ask the overview question only once
// per app session so landing on chat doesn't re-bill the LLM each time.
let askedOverviewThisSession = false;

function formatMeta(meta: ChatMeta): string {
  const parts: string[] = [];
  if (meta.inputTokens !== undefined) parts.push(`↑${meta.inputTokens} tok`);
  else if (meta.promptTokensEst !== undefined) parts.push(`↑~${meta.promptTokensEst} tok`);
  if (meta.outputTokens !== undefined) parts.push(`↓${meta.outputTokens} tok`);
  parts.push(`${((Date.now() - meta.startedAt) / 1000).toFixed(1)}s`);
  if (meta.costTotal && meta.costTotal > 0) parts.push(`$${meta.costTotal.toFixed(4)}`);
  return parts.join(' · ');
}

function ChatView({ onToast }: ChatViewProps) {
  const { t } = useTranslation();
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

  // Free-text questions go to the server-side LLM chat: text deltas stream on
  // the `chat-event` channel and render as markdown into a single bot bubble.
  const askModel = useCallback(
    async (text: string) => {
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
        await invokeChat(text);
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
    [push, onToast],
  );

  // Auto-ask the overview on first render so the landing page is useful
  // without any input.
  useEffect(() => {
    if (!askedOverviewThisSession) {
      askedOverviewThisSession = true;
      void askModel(t('chat.qOverview'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void askModel(text);
  };

  const liveElapsed = live ? ((now - live.startedAt) / 1000).toFixed(1) : null;

  return (
    <div className="page-inner chat">
      <div className="ph">
        <div>
          <h1>{t('chat.title')}</h1>
          <div className="path">{t('chat.subtitle')}</div>
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
