/**
 * ChatPanel render/interaction tests (jsdom). HERMETIC: no window.loqui, no
 * Electron, no sidecar — the LoquiChatApi is injected as a controllable fake
 * whose `onStream` callback we drive to emit scripted token/done/error events.
 *
 * Covers: streaming tokens render incrementally, the provider/model indicator,
 * the read-only notice, suggested prompts, the thinking + error states, and the
 * structural read-only guarantee (the bridge the panel uses has no transcript
 * writer).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  ApiKeyStatus,
  ChatSendParams,
  ChatStreamEvent,
  ProviderConfig,
} from "@loqui/shared";
import { ChatPanel } from "./ChatPanel.js";
import type { LoquiChatApi } from "../../preload/index.js";

afterEach(cleanup);

const ANTHROPIC_CONFIG: ProviderConfig = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  baseUrl: "http://localhost:11434",
  ollamaModel: "llama3.1",
  cli: "claude",
  nativeModel: "",
  summaryTemplate: "",
};

interface FakeChat {
  api: LoquiChatApi;
  emit: (event: ChatStreamEvent) => void;
  sends: ChatSendParams[];
}

function makeChat(overrides: Partial<LoquiChatApi> = {}, config = ANTHROPIC_CONFIG): FakeChat {
  let streamCb: ((e: ChatStreamEvent) => void) | null = null;
  const sends: ChatSendParams[] = [];
  const api: LoquiChatApi = {
    send: vi.fn((params: ChatSendParams) => {
      sends.push(params);
    }),
    onStream: (cb) => {
      streamCb = cb;
      return () => {
        streamCb = null;
      };
    },
    getProviderSettings: vi.fn(async () => config),
    setProviderSettings: vi.fn(async (c: ProviderConfig) => c),
    setApiKey: vi.fn(async (): Promise<ApiKeyStatus> => ({ provider: "anthropic", hasKey: true })),
    getApiKeyStatus: vi.fn(
      async (): Promise<ApiKeyStatus> => ({ provider: "anthropic", hasKey: false }),
    ),
    ...overrides,
  };
  return { api, emit: (e) => act(() => streamCb?.(e)), sends };
}

const lastChatId = (chat: FakeChat): string => {
  const id = chat.sends[chat.sends.length - 1]?.chatId;
  if (!id) throw new Error("no send recorded");
  return id;
};

describe("ChatPanel", () => {
  it("shows the active provider/model indicator from the bridge", async () => {
    const chat = makeChat();
    render(<ChatPanel meetingId="m1" api={chat.api} />);
    await waitFor(() =>
      expect(screen.getByTestId("chat-provider-indicator").textContent).toContain(
        "Claude Opus 4.8",
      ),
    );
    expect(screen.getByTestId("chat-provider-indicator").textContent).toContain("Anthropic");
  });

  it("does not surface the dev-only read-only invariant as user copy", () => {
    // The AI-never-edits-the-transcript guarantee is a structural invariant
    // (enforced by the bridge having no transcript writer — see the last test),
    // not user-facing chrome. The panel must not nag about it.
    const chat = makeChat();
    render(<ChatPanel meetingId="m1" api={chat.api} />);
    expect(screen.queryByTestId("chat-readonly-note")).toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toContain("never edits it");
  });

  it("renders streamed tokens incrementally then finalizes on done", async () => {
    const chat = makeChat();
    render(<ChatPanel meetingId="m1" api={chat.api} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "What was decided?" } });
    fireEvent.click(screen.getByTestId("chat-send"));

    // The user turn appears and a send was fired with the conversation.
    await waitFor(() => expect(chat.sends.length).toBe(1));
    expect(screen.getByTestId("chat-turn-user").textContent).toContain("What was decided?");
    expect(chat.sends[0]!.meetingId).toBe("m1");
    expect(chat.sends[0]!.messages.at(-1)).toMatchObject({
      role: "user",
      content: "What was decided?",
    });

    const id = lastChatId(chat);
    // Before any token: a "thinking" affordance and a busy panel.
    expect(screen.getByTestId("chat-thinking")).toBeTruthy();
    expect(screen.getByTestId("chat-panel").getAttribute("data-busy")).toBe("true");

    chat.emit({ kind: "token", chatId: id, delta: "We " });
    await waitFor(() =>
      expect(screen.getByTestId("chat-bubble-assistant").textContent).toContain("We "),
    );
    chat.emit({ kind: "token", chatId: id, delta: "shipped." });
    await waitFor(() =>
      expect(screen.getByTestId("chat-bubble-assistant").textContent).toContain("We shipped."),
    );

    chat.emit({ kind: "done", chatId: id, text: "We shipped.", provider: "anthropic", model: "claude-opus-4-8" });
    await waitFor(() =>
      expect(screen.getByTestId("chat-panel").getAttribute("data-busy")).toBe("false"),
    );
    // The composer is usable again.
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).textContent).toBe("Send");
  });

  it("renders an actionable error state when the stream errors", async () => {
    const chat = makeChat();
    render(<ChatPanel meetingId="m1" api={chat.api} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Summarize" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(chat.sends.length).toBe(1));

    chat.emit({
      kind: "error",
      chatId: lastChatId(chat),
      code: "ollama_unreachable",
      message: "Ollama is not running at http://localhost:11434",
    });

    await waitFor(() => expect(screen.getByTestId("chat-error")).toBeTruthy());
    expect(screen.getByTestId("chat-error").textContent).toContain("Ollama is not running");
    // Not stuck busy.
    expect(screen.getByTestId("chat-panel").getAttribute("data-busy")).toBe("false");
  });

  it("offers suggested prompts that send on click", async () => {
    const chat = makeChat();
    render(<ChatPanel meetingId="m1" api={chat.api} />);

    const suggestions = await screen.findAllByTestId("chat-suggestion");
    expect(suggestions.length).toBeGreaterThan(0);
    const actionItems = suggestions.find((b) => b.textContent?.includes("action items"));
    expect(actionItems).toBeTruthy();

    fireEvent.click(actionItems as HTMLElement);
    await waitFor(() => expect(chat.sends.length).toBe(1));
    expect(chat.sends[0]!.messages.at(-1)?.content).toContain("action items");
  });

  it("disables sending until a meeting is present", () => {
    const chat = makeChat();
    render(<ChatPanel meetingId={null} api={chat.api} />);
    expect((screen.getByTestId("chat-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("resets the conversation when the meeting changes", async () => {
    const chat = makeChat();
    const { rerender } = render(<ChatPanel meetingId="m1" api={chat.api} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getByTestId("chat-turn-user")).toBeTruthy());

    rerender(<ChatPanel meetingId="m2" api={chat.api} />);
    await waitFor(() => expect(screen.getByTestId("chat-empty")).toBeTruthy());
    expect(screen.queryByTestId("chat-turn-user")).toBeNull();
  });

  it("does not send blank messages", async () => {
    const chat = makeChat();
    render(<ChatPanel meetingId="m1" api={chat.api} />);
    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "   " } });
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the chat bridge surface the panel uses exposes no transcript writer", () => {
    const chat = makeChat();
    // Structural guarantee: every method on the bridge is read-only-over-the-
    // transcript (send streams a completion; the rest are settings/key/status).
    const names = Object.keys(chat.api).join(" ");
    expect(names).not.toMatch(/writeTranscript|patchTranscript|saveTranscript|setTranscript|writeMeta/i);
  });
});
