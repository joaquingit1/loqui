/**
 * Pure chat-conversation model (PRD-4 renderer). No React, no IPC — just the
 * data shapes + reducers the {@link useChat} hook and the ChatPanel render. Kept
 * pure so it is trivially unit-testable and so the streaming fold has one
 * authoritative implementation.
 *
 * READ-ONLY over the transcript: nothing in this module (or the hook built on
 * it) can write a transcript/meta file. The renderer only ever sends a
 * conversation + provider config via the {@link LoquiChatApi} bridge and folds
 * the streamed reply; the transcript is read (and grounded against) entirely in
 * the sidecar.
 */
import type { ChatProvider, ChatRole, ChatStreamEvent } from "@loqui/shared";

/**
 * One rendered turn in the panel. `pending` marks the assistant message that is
 * currently streaming (so the UI can show a caret/typing affordance until the
 * terminal `done`/`error` arrives). `error` carries an actionable failure that
 * replaces the streamed text for that turn.
 */
export interface ChatTurn {
  /** Stable id for React keys. For an assistant turn this is the `chatId`. */
  id: string;
  role: ChatRole;
  content: string;
  /** True while this assistant turn is still streaming tokens. */
  pending?: boolean;
  /** Set when the turn terminated with an error (replaces the bubble body). */
  error?: string;
}

/** The full per-meeting chat state the hook exposes. */
export interface ChatState {
  turns: ChatTurn[];
  /** True while any assistant turn is streaming (drives composer disabled). */
  busy: boolean;
  /** The chatId of the in-flight assistant turn, if any (for stream routing). */
  activeChatId: string | null;
  /** Provider/model that actually served the last completed turn (for the badge). */
  lastServed: { provider?: ChatProvider; model?: string } | null;
}

export const emptyChatState: ChatState = {
  turns: [],
  busy: false,
  activeChatId: null,
  lastServed: null,
};

/** Append a user turn + an empty pending assistant turn keyed by `chatId`. */
export function startTurn(state: ChatState, chatId: string, userText: string): ChatState {
  return {
    ...state,
    turns: [
      ...state.turns,
      { id: `u-${chatId}`, role: "user", content: userText },
      { id: chatId, role: "assistant", content: "", pending: true },
    ],
    busy: true,
    activeChatId: chatId,
  };
}

/**
 * Fold one streamed {@link ChatStreamEvent} into the conversation. Events for a
 * chatId that is not the active assistant turn are ignored (a late event from a
 * superseded send must never bleed into the current bubble). `token` appends to
 * the pending bubble; `done` finalizes it (and records the serving
 * provider/model); `error` replaces the bubble body with the actionable message.
 */
export function applyStreamEvent(state: ChatState, event: ChatStreamEvent): ChatState {
  const idx = state.turns.findIndex((t) => t.id === event.chatId && t.role === "assistant");
  const turn = idx === -1 ? undefined : state.turns[idx];
  if (!turn) return state;

  const turns = state.turns.slice();

  switch (event.kind) {
    case "token": {
      turns[idx] = { ...turn, content: turn.content + event.delta, pending: true };
      return { ...state, turns };
    }
    case "done": {
      // Prefer the assembled `text` (so a late-attaching panel reconciles), but
      // fall back to whatever streamed if `text` is empty.
      const content = event.text || turn.content;
      turns[idx] = { ...turn, content, pending: false };
      return {
        ...state,
        turns,
        busy: false,
        activeChatId: null,
        lastServed: { provider: event.provider, model: event.model },
      };
    }
    case "error": {
      turns[idx] = {
        ...turn,
        pending: false,
        error: event.message || "The chat request failed.",
      };
      return { ...state, turns, busy: false, activeChatId: null };
    }
    default: {
      return state;
    }
  }
}
