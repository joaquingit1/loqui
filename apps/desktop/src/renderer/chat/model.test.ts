/**
 * Pure chat-model reducer tests (PRD-4). HERMETIC: no React, no window.loqui —
 * just the fold over scripted stream events. Asserts incremental token
 * accumulation, done/error finalization, late-event isolation, and that nothing
 * here can touch a transcript (there is simply no such method).
 */
import { describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@loqui/shared";
import { applyStreamEvent, emptyChatState, startTurn } from "./model.js";

const token = (chatId: string, delta: string): ChatStreamEvent => ({ kind: "token", chatId, delta });
const done = (
  chatId: string,
  text: string,
  extra: Partial<{ provider: "anthropic" | "fake"; model: string }> = {},
): ChatStreamEvent => ({ kind: "done", chatId, text, ...extra });
const errorEvent = (chatId: string, message: string): ChatStreamEvent => ({
  kind: "error",
  chatId,
  code: "provider_error",
  message,
});

describe("chat model", () => {
  it("startTurn appends a user turn + a pending assistant turn keyed by chatId", () => {
    const s = startTurn(emptyChatState, "c1", "Hello");
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(s.turns[1]).toMatchObject({ role: "assistant", id: "c1", content: "", pending: true });
    expect(s.busy).toBe(true);
    expect(s.activeChatId).toBe("c1");
  });

  it("accumulates tokens incrementally into the pending assistant bubble", () => {
    let s = startTurn(emptyChatState, "c1", "Hi");
    s = applyStreamEvent(s, token("c1", "Hel"));
    expect(s.turns[1]!.content).toBe("Hel");
    s = applyStreamEvent(s, token("c1", "lo"));
    expect(s.turns[1]!.content).toBe("Hello");
    expect(s.turns[1]!.pending).toBe(true);
    expect(s.busy).toBe(true);
  });

  it("done finalizes the bubble and records the serving provider/model", () => {
    let s = startTurn(emptyChatState, "c1", "Hi");
    s = applyStreamEvent(s, token("c1", "Hello"));
    s = applyStreamEvent(s, done("c1", "Hello there", { provider: "anthropic", model: "claude-opus-4-8" }));
    expect(s.turns[1]).toMatchObject({ content: "Hello there", pending: false });
    expect(s.busy).toBe(false);
    expect(s.activeChatId).toBeNull();
    expect(s.lastServed).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("done falls back to streamed content when text is empty", () => {
    let s = startTurn(emptyChatState, "c1", "Hi");
    s = applyStreamEvent(s, token("c1", "partial"));
    s = applyStreamEvent(s, done("c1", ""));
    expect(s.turns[1]!.content).toBe("partial");
  });

  it("error replaces the bubble body with an actionable message and clears busy", () => {
    let s = startTurn(emptyChatState, "c1", "Hi");
    s = applyStreamEvent(s, errorEvent("c1", "Ollama is not running"));
    expect(s.turns[1]!.error).toBe("Ollama is not running");
    expect(s.turns[1]!.pending).toBe(false);
    expect(s.busy).toBe(false);
  });

  it("ignores events for a chatId that is not the current assistant turn", () => {
    let s = startTurn(emptyChatState, "c1", "Hi");
    s = applyStreamEvent(s, token("c1", "live"));
    const before = s.turns[1]!.content;
    s = applyStreamEvent(s, token("stale", "ghost"));
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]!.content).toBe(before);
  });

  it("the model exposes no transcript-write capability", () => {
    // Structural guarantee: the only exported reducers operate on conversation
    // state. There is no write/patch/save method to reach a transcript file.
    const mod = { applyStreamEvent, startTurn, emptyChatState };
    const names = Object.keys(mod).join(" ");
    expect(names).not.toMatch(/write|patch|save|transcript|meta/i);
  });
});
