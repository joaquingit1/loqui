/**
 * PRD-6 — WS client tests against a FAKE in-process socket (no real network).
 *
 * Asserts: connects to the pinned loopback endpoint; buffers sends while not yet
 * open and flushes on open; re-sends `hello` first on (re)connect; `send` is a
 * silent no-op (queues, never throws) when down; `close` sends `bye` + closes +
 * is idempotent + stops reconnects; a construction throw degrades silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SPEAKERNAMES_WS_DEFAULT_PORT,
  SPEAKERNAMES_WS_HOST,
  SPEAKERNAMES_WS_PATH,
  type ExtensionMessage,
} from "@loqui/shared";
import { createMeetEventSender } from "./ws-client.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** A controllable fake WebSocket capturing the URL + sent frames. */
class FakeSocket {
  static readonly OPEN = OPEN;
  static instances: FakeSocket[] = [];

  readyState = CONNECTING;
  readonly url: string;
  sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("not open");
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
    this.onclose?.();
  }

  fail(): void {
    this.onerror?.();
    this.close();
  }

  parsed(): ExtensionMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ExtensionMessage);
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const hello: ExtensionMessage = {
  type: "hello",
  extensionVersion: "0.1.0",
  selectorVersion: "2026-06-24",
  meetingCode: "abc-defg-hij",
  origin: "https://meet.google.com",
};
const activity = (ts: number, name: string, speaking: boolean): ExtensionMessage => ({
  type: "activity",
  event: { ts, name, speaking },
});

function makeSender(port?: number) {
  return createMeetEventSender({
    WebSocketCtor: FakeSocket as unknown as typeof WebSocket,
    port,
  });
}

/** Non-null indexed access (noUncheckedIndexedAccess is on). */
function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}

describe("createMeetEventSender — endpoint + buffering", () => {
  it("dials the pinned loopback endpoint", () => {
    makeSender();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(at(FakeSocket.instances, 0).url).toBe(
      `ws://${SPEAKERNAMES_WS_HOST}:${SPEAKERNAMES_WS_DEFAULT_PORT}${SPEAKERNAMES_WS_PATH}`,
    );
  });

  it("honors a custom port", () => {
    makeSender(0);
    expect(at(FakeSocket.instances, 0).url).toBe(
      `ws://${SPEAKERNAMES_WS_HOST}:0${SPEAKERNAMES_WS_PATH}`,
    );
  });

  it("buffers sends while connecting, then flushes on open (hello first)", () => {
    const sender = makeSender();
    const sock = at(FakeSocket.instances, 0);
    // Not open yet — these queue silently.
    sender.send(hello);
    sender.send(activity(1, "Alex", true));
    sender.send(activity(2, "Alex", false));
    expect(sock.sent).toHaveLength(0);

    sock.open();
    const frames = sock.parsed();
    expect(at(frames, 0).type).toBe("hello"); // hello re-sent first on (re)connect
    expect(frames.slice(1)).toEqual([
      activity(1, "Alex", true),
      activity(2, "Alex", false),
    ]);
  });

  it("sends immediately once open", () => {
    const sender = makeSender();
    const sock = at(FakeSocket.instances, 0);
    sock.open();
    sender.send(activity(5, "Jordan", true));
    expect(sock.parsed()).toEqual([activity(5, "Jordan", true)]);
  });
});

describe("createMeetEventSender — reconnect", () => {
  it("reconnects with backoff and re-announces hello", () => {
    const sender = makeSender();
    const sock1 = at(FakeSocket.instances, 0);
    sock1.open();
    sender.send(hello);
    expect(at(sock1.parsed(), 0).type).toBe("hello");

    // Drop the socket; a reconnect is scheduled (backoff).
    sock1.close();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    const sock2 = at(FakeSocket.instances, 1);
    sock2.open();
    // hello re-announced automatically on the new socket.
    expect(at(sock2.parsed(), 0)).toMatchObject({ type: "hello" });
  });

  it("is a silent no-op (queues, never throws) while down", () => {
    const sender = makeSender();
    const sock = at(FakeSocket.instances, 0);
    sock.fail(); // refused — Loqui not running
    expect(() => sender.send(activity(1, "Alex", true))).not.toThrow();
    // Nothing delivered while down.
    expect(sock.sent).toHaveLength(0);
  });
});

describe("createMeetEventSender — close()", () => {
  it("sends bye, closes the socket, and stops reconnecting (idempotent)", () => {
    const sender = makeSender();
    const sock = at(FakeSocket.instances, 0);
    sock.open();
    sender.close("pagehide");
    const frames = sock.parsed();
    expect(frames.at(-1)).toEqual({ type: "bye", reason: "pagehide" });
    expect(sock.closed).toBe(true);

    // Idempotent + no reconnect after close.
    sender.close("again");
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("send() after close is a no-op", () => {
    const sender = makeSender();
    const sock = at(FakeSocket.instances, 0);
    sock.open();
    sender.close();
    const before = sock.sent.length;
    sender.send(activity(9, "Alex", true));
    expect(sock.sent.length).toBe(before);
  });
});

describe("createMeetEventSender — degradation", () => {
  it("degrades to a no-op when no WebSocket is available", () => {
    // Hermetic: remove the global WebSocket so resolveCtor finds nothing and the
    // sender never dials a real network (Node provides a global WebSocket).
    const g = globalThis as { WebSocket?: typeof WebSocket };
    const saved = g.WebSocket;
    delete g.WebSocket;
    try {
      const sender = createMeetEventSender({ WebSocketCtor: undefined });
      expect(FakeSocket.instances).toHaveLength(0);
      expect(() => sender.send(hello)).not.toThrow();
      expect(() => sender.close()).not.toThrow();
    } finally {
      g.WebSocket = saved;
    }
  });

  it("retries quietly when construction throws", () => {
    let attempts = 0;
    class ThrowOnceSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        attempts += 1;
        if (attempts === 1) throw new Error("refused");
      }
    }
    const sender = createMeetEventSender({
      WebSocketCtor: ThrowOnceSocket as unknown as typeof WebSocket,
    });
    void sender;
    // First construction threw; a reconnect is scheduled.
    vi.advanceTimersByTime(1000);
    expect(attempts).toBe(2);
  });
});
