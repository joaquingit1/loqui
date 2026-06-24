/**
 * ChatPanel — the in-call AI chat surface (PRD-4).
 *
 * Lets the user chat with the configured AI about the LIVE meeting transcript:
 *   - per-meeting message history (resets when the meeting changes);
 *   - a composer (textarea + Send) that streams the assistant reply token-by-
 *     token via {@link useChat};
 *   - "thinking" (pending) + error states per assistant turn;
 *   - a visible indicator of the active provider/model (and a link into
 *     {@link ProviderSettings} to change it without a restart);
 *   - one-tap suggested prompts ("What action items came up?", …);
 *   - a standing notice that the AI READS the transcript but cannot change it.
 *
 * READ-ONLY over the transcript: this component (and the hook it uses) only
 * sends a conversation + provider config over the typed `window.loqui.chat`
 * bridge and renders the streamed reply. There is no method here — and none on
 * the bridge — that writes a transcript or meta file. The sidecar reads and
 * grounds the transcript; the UI cannot touch it.
 *
 * Talks ONLY to the typed `window.loqui.chat` bridge (injectable for tests),
 * never to IPC channels or Node globals.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { ProviderConfig } from "@loqui/shared";
import type { LoquiChatApi } from "../../preload/index.js";
import {
  SUGGESTED_PROMPTS,
  providerSummary,
  useChat,
  type ChatTurn,
} from "../chat/index.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { HfTokenSettings } from "../summary/index.js";
import "../chat/chat.css";

export interface ChatPanelProps {
  /** The meeting to ground the chat in. A null id disables sending. */
  meetingId?: string | null;
  /** Chat bridge. Injectable for tests; defaults to window.loqui.chat. */
  api?: LoquiChatApi;
}

/** Distance from the bottom (px) still considered "at the bottom" for auto-scroll. */
const STICK_THRESHOLD_PX = 24;

export function ChatPanel({ meetingId, api }: ChatPanelProps): JSX.Element {
  const chat = api ?? (typeof window !== "undefined" ? window.loqui?.chat : undefined);

  // The active provider settings drive the indicator + each send. Loaded from
  // the bridge; re-read whenever settings are saved (no restart — AC #3).
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const loadConfig = useCallback(() => {
    if (!chat?.getProviderSettings) return;
    chat
      .getProviderSettings()
      .then(setConfig)
      .catch(() => {
        /* leave the indicator unknown; sending still works with sidecar defaults */
      });
  }, [chat]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const { state, canSend, send } = useChat({
    api: chat,
    meetingId,
    providerConfig: config ?? undefined,
  });

  const [draft, setDraft] = useState("");

  const onSend = useCallback(() => {
    if (!canSend) return;
    const text = draft;
    if (text.trim().length === 0) return;
    send(text);
    setDraft("");
  }, [canSend, draft, send]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend],
  );

  const onSuggested = useCallback(
    (prompt: string) => {
      if (!canSend) return;
      send(prompt);
      setDraft("");
    },
    [canSend, send],
  );

  const onSettingsSaved = useCallback(
    (next: ProviderConfig) => {
      setConfig(next);
      setSettingsOpen(false);
    },
    [],
  );

  // Auto-scroll the thread to the latest content while pinned to the bottom.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stick, setStick] = useState(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [state.turns, stick]);

  const disabled = !canSend;
  const hasMeeting = Boolean(meetingId);
  const empty = state.turns.length === 0;

  return (
    <section
      className="panel chat"
      aria-labelledby="chat-title"
      data-testid="chat-panel"
      data-busy={state.busy ? "true" : "false"}
    >
      <div className="chat__bar">
        <div>
          <h2 className="panel__title" id="chat-title">
            Ask about this meeting
          </h2>
          <p className="panel__subtitle">
            The AI reads the live transcript as context — it can’t change it.
          </p>
        </div>
        <button
          type="button"
          className="chat__provider"
          data-testid="chat-provider-indicator"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-expanded={settingsOpen}
          title="Change the AI provider or model"
        >
          {config ? providerSummary(config) : "Loading provider…"}
        </button>
      </div>

      {settingsOpen && (
        <>
          <ProviderSettings api={chat} onSaved={onSettingsSaved} />
          {/* PRD-5: Hugging Face token for gated pyannote diarization weights.
              Sits with the other keychain secret (the AI key); main encrypts it
              via safeStorage. Talks to window.loqui.postprocess itself. */}
          <HfTokenSettings />
        </>
      )}

      <p className="chat__readonly-note" data-testid="chat-readonly-note" role="note">
        Read-only: answers are grounded in the transcript, but the AI never edits it.
      </p>

      <div
        className="chat__thread"
        data-testid="chat-thread"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Chat conversation"
      >
        {empty ? (
          <p className="chat__empty" data-testid="chat-empty">
            {hasMeeting
              ? "Ask a question about what’s being said."
              : "Start or open a meeting to chat about its transcript."}
          </p>
        ) : (
          state.turns.map((turn) => <ChatBubble key={turn.id} turn={turn} />)
        )}
      </div>

      {empty && hasMeeting && (
        <div className="chat__suggestions" data-testid="chat-suggestions">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="chat__suggestion"
              data-testid="chat-suggestion"
              disabled={disabled}
              onClick={() => onSuggested(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div className="chat__composer">
        <textarea
          className="chat__input"
          data-testid="chat-input"
          placeholder={
            hasMeeting ? "Ask about this meeting…" : "Open a meeting to chat"
          }
          value={draft}
          rows={2}
          disabled={!hasMeeting}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Chat message"
        />
        <button
          type="button"
          className="btn chat__send"
          data-testid="chat-send"
          disabled={disabled || draft.trim().length === 0}
          onClick={onSend}
        >
          {state.busy ? "Thinking…" : "Send"}
        </button>
      </div>
    </section>
  );
}

function ChatBubble({ turn }: { turn: ChatTurn }): JSX.Element {
  const isUser = turn.role === "user";
  const isError = Boolean(turn.error);
  // A pending assistant turn with no text yet shows a "thinking" affordance.
  const thinking = turn.role === "assistant" && turn.pending && turn.content.length === 0;

  return (
    <div
      className={`chat__turn chat__turn--${turn.role}${isError ? " chat__turn--error" : ""}`}
      data-testid={`chat-turn-${turn.role}`}
      data-role={turn.role}
      data-pending={turn.pending ? "true" : "false"}
      data-chat-id={turn.id}
    >
      <span className="chat__who">{isUser ? "You" : "AI"}</span>
      {isError ? (
        <p className="chat__bubble chat__bubble--error" data-testid="chat-error" role="alert">
          {turn.error}
        </p>
      ) : thinking ? (
        <p className="chat__bubble chat__bubble--thinking" data-testid="chat-thinking">
          <span className="chat__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="chat__sr">Thinking…</span>
        </p>
      ) : (
        <p className="chat__bubble" data-testid={`chat-bubble-${turn.role}`}>
          {turn.content}
          {turn.pending && <span className="chat__caret" aria-hidden="true" />}
        </p>
      )}
    </div>
  );
}
