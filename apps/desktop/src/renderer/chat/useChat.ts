/**
 * useChat — folds the {@link LoquiChatApi} streaming bridge into the pure
 * {@link ChatState} model (PRD-4 renderer). Owns the per-meeting conversation,
 * subscribes once to `chat.onStream`, routes events by `chatId` to the active
 * assistant turn, and exposes a `send` that mints a chatId + fires the
 * fire-and-forget `chat.send`.
 *
 * READ-ONLY over the transcript: this hook never sends transcript text and has
 * no path to write one — it only ships the conversation + provider config and
 * renders the streamed reply. The sidecar reads/grounds the transcript.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ChatSendParams,
  ChatStreamEvent,
  ProviderConfig,
} from "@loqui/shared";
import type { LoquiChatApi } from "../../preload/index.js";
import {
  applyStreamEvent,
  emptyChatState,
  startTurn,
  type ChatState,
  type ChatTurn,
} from "./model.js";

export interface UseChatOptions {
  /** Chat bridge. Injectable for tests; defaults to window.loqui.chat. */
  api?: Pick<LoquiChatApi, "send" | "onStream">;
  /** The meeting the chat is grounded in. A null id disables sending. */
  meetingId?: string | null;
  /** Active provider config (selected in settings) sent on every turn. */
  providerConfig?: ProviderConfig;
  /** Inject a deterministic id generator for tests. */
  generateId?: () => string;
}

export interface UseChatResult {
  state: ChatState;
  /** Whether a send is allowed right now (idle + has a meeting + non-empty). */
  canSend: boolean;
  /** Send a user turn; no-ops when busy, meetingless, or text is blank. */
  send: (text: string) => void;
}

function defaultId(): string {
  // Prefer the platform UUID; fall back for jsdom/older runtimes.
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The wire conversation = prior turns + the new user message (no system context). */
function toWireMessages(turns: ChatTurn[], userText: string): ChatMessage[] {
  const history: ChatMessage[] = turns
    // Exclude errored turns (no usable content) and any still-pending bubble.
    .filter((t) => !t.error && !t.pending && t.content.length > 0)
    .map((t) => ({ role: t.role, content: t.content }));
  return [...history, { role: "user", content: userText }];
}

export function useChat({
  api,
  meetingId,
  providerConfig,
  generateId,
}: UseChatOptions): UseChatResult {
  const chat = api ?? (typeof window !== "undefined" ? window.loqui?.chat : undefined);
  const [state, setState] = useState<ChatState>(emptyChatState);

  // Keep the latest state available to `send` without making the callback churn.
  const stateRef = useRef(state);
  stateRef.current = state;

  const mintId = generateId ?? defaultId;

  // Reset the conversation when the meeting changes — a different meeting is a
  // different grounding context; a previous meeting's turns must not bleed in.
  useEffect(() => {
    setState(emptyChatState);
  }, [meetingId]);

  // Subscribe once to the stream; fold every event for any in-flight chatId.
  useEffect(() => {
    if (!chat?.onStream) return;
    const unsubscribe = chat.onStream((event: ChatStreamEvent) => {
      setState((prev) => applyStreamEvent(prev, event));
    });
    return unsubscribe;
  }, [chat]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      const current = stateRef.current;
      if (!chat?.send || !meetingId || current.busy || trimmed.length === 0) return;

      const chatId = mintId();
      const messages = toWireMessages(current.turns, trimmed);
      setState((prev) => startTurn(prev, chatId, trimmed));

      const params: ChatSendParams = {
        chatId,
        meetingId,
        messages,
        // Defaulted by the zod schema downstream; pass through when present.
        providerConfig: providerConfig ?? ({} as ProviderConfig),
      };
      chat.send(params);
    },
    [chat, meetingId, providerConfig, mintId],
  );

  const canSend = useMemo(
    () => Boolean(chat?.send) && Boolean(meetingId) && !state.busy,
    [chat, meetingId, state.busy],
  );

  return { state, canSend, send };
}
