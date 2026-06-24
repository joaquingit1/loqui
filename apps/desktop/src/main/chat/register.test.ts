/**
 * Hermetic tests for the main-process chat IPC + WS bridge (PRD-4).
 *
 * `electron` is mocked with a fake `ipcMain` that records `on`/`handle`
 * registrations so we can invoke the bound handlers directly (no Electron
 * runtime). The sidecar supervisor + keystore are fakes. No network, no real
 * keychain, no CLI — fully hermetic.
 *
 * Invariants asserted here:
 *   - `chat:send` validates the payload, pulls the BYOK key from the keystore for
 *     key-requiring providers (and only those), and forwards a `chatRequest` WS
 *     notification carrying {chatId, meetingId, messages, providerConfig, apiKey};
 *   - malformed sends are dropped, never forwarded;
 *   - the streamed chatToken/chatDone/chatError notifications are normalized into
 *     tagged ChatStreamEvents and pushed to the renderer; non-chat / malformed
 *     notifications are ignored;
 *   - the provider-settings + key invoke handlers delegate to the keystore and
 *     never return the key;
 *   - the bridge has NO transcript-write capability (structural assertion).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Fake electron ipcMain (records registrations; lets us invoke handlers) ---
interface RecordedHandlers {
  on: Map<string, (e: unknown, ...args: unknown[]) => void>;
  handle: Map<string, (e: unknown, ...args: unknown[]) => unknown>;
  removedHandlers: string[];
  removedListeners: string[];
}

const handlers: RecordedHandlers = {
  on: new Map(),
  handle: new Map(),
  removedHandlers: [],
  removedListeners: [],
};

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (e: unknown, ...args: unknown[]) => void) => {
      handlers.on.set(channel, listener);
    },
    handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.handle.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.removedHandlers.push(channel);
      handlers.handle.delete(channel);
    },
    removeListener: (channel: string) => {
      handlers.removedListeners.push(channel);
      handlers.on.delete(channel);
    },
  },
}));

// Imported AFTER the mock so the module binds the fake ipcMain.
const { registerChatIpc, forwardChatStream } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");
type ChatKeystore = import("./keystore.js").ChatKeystore;

/**
 * Recorder fields the tests inspect, alongside the public ChatKeystore surface
 * the bridge calls. ChatKeystore has private fields (#safeStorage etc.), so the
 * structural fake is not assignable to it without a cast — {@link makeKeystore}
 * narrows that cast to one place so every call site stays clean.
 */
type FakeKeystore = ChatKeystore & {
  getApiKeyCalls: string[];
  setProviderCalls: unknown[];
  setApiKeyCalls: unknown[];
};

// --- Fakes for the supervisor + keystore deps --------------------------------
function makeSupervisor() {
  const notifications: Array<{ event: string; data: unknown }> = [];
  let notificationCb: ((event: string, data: unknown) => void) | null = null;
  return {
    notifications,
    emit(event: string, data: unknown) {
      notificationCb?.(event, data);
    },
    sendControlNotification(event: string, data: unknown): boolean {
      notifications.push({ event, data });
      return true;
    },
    onNotification(cb: (event: string, data: unknown) => void): () => void {
      notificationCb = cb;
      return () => {
        notificationCb = null;
      };
    },
  };
}

function makeKeystore(storedKey: string | null = null): FakeKeystore {
  const fake = {
    getApiKeyCalls: [] as string[],
    setProviderCalls: [] as unknown[],
    setApiKeyCalls: [] as unknown[],
    getProviderSettings: () => ({
      provider: "fake",
      model: "claude-opus-4-8",
      baseUrl: "http://localhost:11434",
      ollamaModel: "llama3.1",
      cli: "claude",
    }),
    setProviderSettings(config: unknown) {
      fake.setProviderCalls.push(config);
      return config;
    },
    setApiKey(params: unknown) {
      fake.setApiKeyCalls.push(params);
      const p = params as { provider: string; apiKey: string | null };
      return { provider: p.provider, hasKey: Boolean(p.apiKey && p.apiKey.trim()) };
    },
    getApiKeyStatus(provider: string) {
      return { provider, hasKey: storedKey !== null };
    },
    getApiKey(provider: string): string | null {
      fake.getApiKeyCalls.push(provider);
      return storedKey;
    },
  };
  return fake as unknown as FakeKeystore;
}

beforeEach(() => {
  handlers.on.clear();
  handlers.handle.clear();
  handlers.removedHandlers = [];
  handlers.removedListeners = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerChatIpc — chat:send forwarding", () => {
  it("forwards a valid send as a chatRequest WS notification with the keychain key", () => {
    const supervisor = makeSupervisor();
    const keystore = makeKeystore("sk-ant-KEY");
    registerChatIpc({ supervisor, keystore });

    const onSend = handlers.on.get(IPC.chatSend)!;
    expect(onSend).toBeTypeOf("function");

    onSend(null, {
      chatId: "c1",
      meetingId: "m1",
      messages: [{ role: "user", content: "What action items came up?" }],
      providerConfig: { provider: "anthropic", model: "claude-opus-4-8" },
    });

    expect(supervisor.notifications).toHaveLength(1);
    const { event, data } = supervisor.notifications[0]!;
    expect(event).toBe("chatRequest");
    expect(data).toMatchObject({
      chatId: "c1",
      meetingId: "m1",
      apiKey: "sk-ant-KEY",
    });
    const payload = data as { providerConfig: { provider: string }; messages: unknown[] };
    expect(payload.providerConfig.provider).toBe("anthropic");
    expect(payload.messages).toHaveLength(1);
    // The keystore was asked for the anthropic key.
    expect(keystore.getApiKeyCalls).toEqual(["anthropic"]);
  });

  it("forwards null apiKey for local providers and does NOT touch the keystore key", () => {
    const supervisor = makeSupervisor();
    const keystore = makeKeystore("sk-ant-KEY");
    registerChatIpc({ supervisor, keystore });

    const onSend = handlers.on.get(IPC.chatSend)!;
    for (const provider of ["fake", "ollama", "agent-cli"]) {
      supervisor.notifications.length = 0;
      keystore.getApiKeyCalls.length = 0;
      onSend(null, {
        chatId: "c",
        meetingId: "m",
        messages: [],
        providerConfig: { provider },
      });
      expect(supervisor.notifications).toHaveLength(1);
      expect((supervisor.notifications[0]!.data as { apiKey: unknown }).apiKey).toBeNull();
      // Never decrypts a key for a non-key provider.
      expect(keystore.getApiKeyCalls).toEqual([]);
    }
  });

  it("drops malformed sends — never forwards", () => {
    const supervisor = makeSupervisor();
    const keystore = makeKeystore("sk-ant-KEY");
    registerChatIpc({ supervisor, keystore });
    const onSend = handlers.on.get(IPC.chatSend)!;

    // Missing chatId (min 1) -> dropped.
    onSend(null, { meetingId: "m", messages: [], providerConfig: {} });
    // Not an object -> dropped.
    onSend(null, "nope");
    onSend(null, null);

    expect(supervisor.notifications).toHaveLength(0);
  });

  it("surfaces a missing key as a null apiKey (sidecar emits the actionable error)", () => {
    const supervisor = makeSupervisor();
    const keystore = makeKeystore(null); // no stored key
    registerChatIpc({ supervisor, keystore });
    const onSend = handlers.on.get(IPC.chatSend)!;

    onSend(null, {
      chatId: "c1",
      meetingId: "m1",
      messages: [],
      providerConfig: { provider: "anthropic" },
    });

    expect(supervisor.notifications).toHaveLength(1);
    expect((supervisor.notifications[0]!.data as { apiKey: unknown }).apiKey).toBeNull();
  });
});

describe("registerChatIpc — provider settings + key invoke handlers", () => {
  it("getProviderSettings delegates to the keystore", () => {
    const keystore = makeKeystore();
    registerChatIpc({ supervisor: makeSupervisor(), keystore });
    const h = handlers.handle.get(IPC.chatGetProviderSettings)!;
    const result = h(null) as { provider: string };
    expect(result.provider).toBe("fake");
  });

  it("setProviderSettings validates + delegates", () => {
    const keystore = makeKeystore();
    registerChatIpc({ supervisor: makeSupervisor(), keystore });
    const h = handlers.handle.get(IPC.chatSetProviderSettings)!;
    const result = h(null, { provider: "ollama" }) as { provider: string; model: string };
    expect(result.provider).toBe("ollama");
    // zod-defaulted before reaching the keystore.
    expect(result.model).toBe("claude-opus-4-8");
    expect(keystore.setProviderCalls).toHaveLength(1);
  });

  it("setApiKey delegates and returns only {provider, hasKey} — never the key", () => {
    const keystore = makeKeystore();
    registerChatIpc({ supervisor: makeSupervisor(), keystore });
    const h = handlers.handle.get(IPC.chatSetApiKey)!;
    const result = h(null, { provider: "anthropic", apiKey: "sk-ant-SECRET" }) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ provider: "anthropic", hasKey: true });
    expect(JSON.stringify(result)).not.toContain("sk-ant-SECRET");
    expect(keystore.setApiKeyCalls).toHaveLength(1);
  });

  it("getApiKeyStatus defaults the provider and never returns the key", () => {
    const keystore = makeKeystore("present");
    registerChatIpc({ supervisor: makeSupervisor(), keystore });
    const h = handlers.handle.get(IPC.chatGetApiKeyStatus)!;
    const withProvider = h(null, "anthropic") as { provider: string; hasKey: boolean };
    expect(withProvider).toEqual({ provider: "anthropic", hasKey: true });
    // Undefined provider falls back to anthropic.
    const noProvider = h(null, undefined) as { provider: string };
    expect(noProvider.provider).toBe("anthropic");
    // Garbage provider is caught -> anthropic.
    const garbage = h(null, "not-a-provider") as { provider: string };
    expect(garbage.provider).toBe("anthropic");
  });

  it("the disposer removes every handler/listener it registered", () => {
    const dispose = registerChatIpc({ supervisor: makeSupervisor(), keystore: makeKeystore() });
    dispose();
    expect(handlers.removedListeners).toContain(IPC.chatSend);
    expect(handlers.removedHandlers).toEqual(
      expect.arrayContaining([
        IPC.chatGetProviderSettings,
        IPC.chatSetProviderSettings,
        IPC.chatSetApiKey,
        IPC.chatGetApiKeyStatus,
      ]),
    );
  });
});

describe("forwardChatStream — relaying streamed tokens to the renderer", () => {
  function makeWindow() {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    return {
      sent,
      isDestroyed: () => false,
      webContents: {
        send(channel: string, payload: unknown) {
          sent.push({ channel, payload });
        },
      },
    };
  }

  it("normalizes chatToken/chatDone/chatError into tagged ChatStreamEvents", () => {
    const supervisor = makeSupervisor();
    const win = makeWindow();
    forwardChatStream(supervisor, () => win as never);

    supervisor.emit("chatToken", { chatId: "c1", delta: "Hello" });
    supervisor.emit("chatToken", { chatId: "c1", delta: " world" });
    supervisor.emit("chatDone", {
      chatId: "c1",
      text: "Hello world",
      provider: "fake",
      model: "scripted",
    });

    expect(win.sent.map((s) => s.channel)).toEqual([
      IPC.chatStream,
      IPC.chatStream,
      IPC.chatStream,
    ]);
    expect(win.sent[0]!.payload).toEqual({ kind: "token", chatId: "c1", delta: "Hello" });
    expect(win.sent[2]!.payload).toMatchObject({
      kind: "done",
      chatId: "c1",
      text: "Hello world",
    });
  });

  it("relays chatError as a tagged error event", () => {
    const supervisor = makeSupervisor();
    const win = makeWindow();
    forwardChatStream(supervisor, () => win as never);
    supervisor.emit("chatError", {
      chatId: "c1",
      code: "cli_not_found",
      message: "Claude Code CLI not found",
    });
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0]!.payload).toEqual({
      kind: "error",
      chatId: "c1",
      code: "cli_not_found",
      message: "Claude Code CLI not found",
    });
  });

  it("ignores non-chat notifications and malformed chat payloads", () => {
    const supervisor = makeSupervisor();
    const win = makeWindow();
    forwardChatStream(supervisor, () => win as never);

    supervisor.emit("transcriptSegment", { segId: "s1" }); // not a chat event
    supervisor.emit("chatToken", { delta: "no chatId" }); // malformed (chatId min 1)
    supervisor.emit("chatToken", "garbage");

    expect(win.sent).toHaveLength(0);
  });

  it("does not throw when there is no live window", () => {
    const supervisor = makeSupervisor();
    forwardChatStream(supervisor, () => null);
    expect(() => supervisor.emit("chatToken", { chatId: "c1", delta: "x" })).not.toThrow();
  });

  it("does not push to a destroyed window", () => {
    const supervisor = makeSupervisor();
    const sent: unknown[] = [];
    const win = {
      isDestroyed: () => true,
      webContents: { send: (_c: string, p: unknown) => sent.push(p) },
    };
    forwardChatStream(supervisor, () => win as never);
    supervisor.emit("chatToken", { chatId: "c1", delta: "x" });
    expect(sent).toHaveLength(0);
  });

  it("the unsubscribe fn stops relaying", () => {
    const supervisor = makeSupervisor();
    const win = makeWindow();
    const off = forwardChatStream(supervisor, () => win as never);
    off();
    supervisor.emit("chatToken", { chatId: "c1", delta: "x" });
    expect(win.sent).toHaveLength(0);
  });
});

describe("structural: no transcript-write capability", () => {
  it("the register module source imports no TranscriptWriter / store-write surface", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "register.ts"), "utf8");
    // No import of the writer or any store-write module.
    expect(src).not.toMatch(/TranscriptWriter|transcript\/writer/);
    expect(src).not.toMatch(/from ["']\.\.\/store/);
    // It only forwards/relays — there is no fs write call here.
    expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/);
  });

  it("the keystore module reaches no meeting-transcript/meta path and writes only chat-settings.json", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "keystore.ts"), "utf8");
    // The keystore is the OTHER file the chat bridge touches the fs through.
    // It DOES write (the encrypted settings) and DOES import dataRoot from the
    // store — both are fine — but it must never reach a meeting transcript/meta
    // path helper, and the only file it writes is chat-settings.json (never
    // under meetings/<id>/), so it structurally cannot touch a transcript.
    expect(src).not.toMatch(/TranscriptWriter|transcript\/writer|appendTranscriptSegment|writeMeta/);
    expect(src).not.toMatch(/meetingTranscriptPath|meetingMetaPath|meetingDir|transcript\.live|meta\.json/);
    expect(src).not.toMatch(/from ["']\.\.\/store\/(?!paths)/); // store import limited to paths.js (dataRoot)
    // The only on-disk path it constructs/writes is chat-settings.json.
    const writeMatches = src.match(/writeFileSync\([^)]*\)/g) ?? [];
    expect(writeMatches.length).toBeGreaterThan(0);
    expect(src).toMatch(/CHAT_SETTINGS_FILE\s*=\s*["']chat-settings\.json["']/);
    // No path string targeting a meeting directory.
    expect(src).not.toMatch(/["'][^"']*meetings[^"']*["']/);
  });
});
