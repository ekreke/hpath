// Chat / system status view. All messages — typed text and quick-query chips
// alike — go to the server-side LLM chat, which answers from a live snapshot
// of system state (configured in Settings); streamed text deltas render into
// a bot bubble.
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { invokeChat, type ChatEvent } from '../lib/ipc';

type ChatViewProps = {
  onToast: (text: string, error?: boolean) => void;
};

type Message = {
  id: number;
  role: 'user' | 'bot';
  text: string;
  streaming?: boolean;
};

let nextId = 1;
// ChatView remounts on every tab switch; ask the overview question only once
// per app session so landing on chat doesn't re-bill the LLM each time.
let askedOverviewThisSession = false;

function ChatView({ onToast }: ChatViewProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const push = useCallback((m: Message) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Free-text questions go to the server-side LLM chat: text deltas stream on
  // the `chat-event` channel and render into a single bot bubble.
  const askModel = useCallback(
    async (text: string) => {
      push({ id: nextId++, role: 'user', text });
      setBusy(true);
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
        } else {
          append({
            streaming: false,
            text: `${t('chat.modelError')}: ${ev.message}`,
          });
        }
      });
      try {
        await invokeChat(text);
      } catch (err) {
        append({ streaming: false, text: String(err) });
        onToast(String(err), true);
      } finally {
        active = false;
        unlisten();
        append({ streaming: false });
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
              <p>
                {m.text || (m.streaming ? '…' : '')}
                {m.streaming && m.text ? <span className="dim">▍</span> : null}
              </p>
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
    </div>
  );
}

export default ChatView;
