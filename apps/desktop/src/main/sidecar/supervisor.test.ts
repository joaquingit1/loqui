import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@loqui/shared";
import { SidecarSupervisor } from "./supervisor.js";
import type { RawSocket } from "./client.js";
import type { SpawnFn } from "./launcher.js";

/**
 * Fully in-memory fakes: no real process, no real socket, no network, no env.
 * Pass/fail is decided entirely by the injected seams.
 */

class FakeStdout extends EventEmitter {
  push(chunk: string): void {
    this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStdout();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  signals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.killed = true;
    // Simulate prompt exit on a kill signal.
    queueMicrotask(() => this.exit(0));
    return true;
  }

  exit(code: number | null): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

class FakeSocket extends EventEmitter implements RawSocket {
  sent: string[] = [];
  closed = false;
  /** Auto-reply to control requests with canned responses. */
  autoRespond = true;

  send(data: string): void {
    this.sent.push(data);
    if (!this.autoRespond) return;
    const msg = JSON.parse(data) as { id: string; method: string };
    queueMicrotask(() => {
      if (msg.method === "getHealth") {
        this.reply(msg.id, {
          status: "ok",
          version: "1.2.3",
          protocolVersion: PROTOCOL_VERSION,
          models: {},
        });
      } else if (msg.method === "ping") {
        this.reply(msg.id, { pong: true, ts: 42 });
      } else if (msg.method === "shutdown") {
        this.reply(msg.id, { shuttingDown: true });
      }
    });
  }

  reply(id: string, result: unknown): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "response", id, ok: true, result }), "utf8"),
    );
  }

  /** Simulate a server-initiated notification frame (sidecar -> main). */
  notify(event: string, data: unknown): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "notification", event, data }), "utf8"),
    );
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }
  terminate(): void {
    this.close();
  }
}

function handshakeLine(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      port: 50505,
      token: "tok-123",
      protocolVersion: PROTOCOL_VERSION,
      ...overrides,
    }) + "\n"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SidecarSupervisor — happy path", () => {
  it("spawns, reads the handshake, connects, health-checks, and reports connected", async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const spawn: SpawnFn = vi.fn(() => {
      // Emit the handshake on the next tick (after listeners attach).
      queueMicrotask(() => child.stdout.push(handshakeLine()));
      return child as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async (port: number, token: string) => {
      expect(port).toBe(50505);
      expect(token).toBe("tok-123");
      return socket;
    });

    const statuses: string[] = [];
    const sup = new SidecarSupervisor({ command: "fake", spawn, connect });
    sup.onStatus((s) => statuses.push(s));

    await sup.start();

    expect(sup.getStatus()).toBe("connected");
    expect(statuses).toContain("connecting");
    expect(statuses[statuses.length - 1]).toBe("connected");
    expect(connect).toHaveBeenCalledOnce();

    const health = await sup.getHealth();
    expect(health).not.toBeNull();
    expect(health?.version).toBe("1.2.3");

    const ping = await sup.ping();
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);

    // Auth rides the connection (the token was presented to connect() above),
    // NOT each request envelope: the sidecar validates frames against the
    // strict WsEnvelope schema, so a `token` key would be rejected as an
    // invalid frame. The request envelope must be {type,id,method} only.
    const pingEnvelope = JSON.parse(socket.sent[socket.sent.length - 1]!) as Record<
      string,
      unknown
    >;
    expect("token" in pingEnvelope).toBe(false);
    expect(pingEnvelope.type).toBe("request");
    expect(pingEnvelope.method).toBe("ping");
  });
});

describe("SidecarSupervisor — protocol version mismatch", () => {
  it("fails loudly and does not connect when the version mismatches", async () => {
    const child = new FakeChild();
    const spawn: SpawnFn = vi.fn(() => {
      queueMicrotask(() => child.stdout.push(handshakeLine({ protocolVersion: "0.0.0" })));
      return child as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => new FakeSocket());

    const sup = new SidecarSupervisor({
      command: "fake",
      spawn,
      connect,
      // No retries so the mismatch surfaces immediately.
      backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 2, jitter: 0, maxRetries: 0 },
      sleep: async () => {},
    });

    await expect(sup.start()).rejects.toThrow(/PROTOCOL_VERSION_MISMATCH/);
    expect(sup.getStatus()).toBe("error");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("SidecarSupervisor — backoff + retry", () => {
  it("retries with backoff after spawn failures, then connects", async () => {
    let attempt = 0;
    const goodChild = new FakeChild();
    const spawn: SpawnFn = vi.fn(() => {
      attempt += 1;
      const c = attempt < 3 ? new FakeChild() : goodChild;
      if (attempt < 3) {
        // Die before emitting a handshake -> connect failure.
        queueMicrotask(() => c.exit(1));
      } else {
        queueMicrotask(() => c.stdout.push(handshakeLine()));
      }
      return c as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => new FakeSocket());

    const delays: number[] = [];
    const sup = new SidecarSupervisor({
      command: "fake",
      spawn,
      connect,
      backoff: { baseDelayMs: 10, maxDelayMs: 1000, factor: 2, jitter: 0, maxRetries: 5 },
      rand: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await sup.start();

    expect(sup.getStatus()).toBe("connected");
    expect(spawn).toHaveBeenCalledTimes(3);
    // Two failed attempts -> two backoff sleeps with geometric (no-jitter) growth.
    expect(delays).toEqual([10, 20]);
  });

  it("gives up and enters error state after exhausting the retry budget", async () => {
    const spawn: SpawnFn = vi.fn(() => {
      const c = new FakeChild();
      queueMicrotask(() => c.exit(1));
      return c as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => new FakeSocket());

    const sup = new SidecarSupervisor({
      command: "fake",
      spawn,
      connect,
      backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 2, jitter: 0, maxRetries: 2 },
      sleep: async () => {},
    });

    await expect(sup.start()).rejects.toThrow(/failed to start after 3 attempt/);
    expect(sup.getStatus()).toBe("error");
    // 1 initial + 2 retries = 3 spawns.
    expect(spawn).toHaveBeenCalledTimes(3);
  });
});

describe("SidecarSupervisor — handshake timeout", () => {
  it("treats a silent child as a connect failure", async () => {
    const spawn: SpawnFn = vi.fn(() => {
      // Never emits a handshake.
      return new FakeChild() as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => new FakeSocket());

    const sup = new SidecarSupervisor({
      command: "fake",
      spawn,
      connect,
      handshakeTimeoutMs: 5,
      backoff: { baseDelayMs: 1, maxDelayMs: 1, factor: 2, jitter: 0, maxRetries: 0 },
      sleep: async () => {},
    });

    await expect(sup.start()).rejects.toThrow(/handshake not received/);
    expect(sup.getStatus()).toBe("error");
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("SidecarSupervisor — clean shutdown", () => {
  it("sends shutdown over WS then SIGTERM, and reports disconnected", async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const spawn: SpawnFn = vi.fn(() => {
      queueMicrotask(() => child.stdout.push(handshakeLine()));
      return child as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => socket);

    const sup = new SidecarSupervisor({ command: "fake", spawn, connect });
    await sup.start();
    expect(sup.getStatus()).toBe("connected");

    await sup.stop();

    // shutdown request was sent over WS.
    const methods = socket.sent.map((s) => (JSON.parse(s) as { method: string }).method);
    expect(methods).toContain("shutdown");
    // SIGTERM was delivered to the child.
    expect(child.signals).toContain("SIGTERM");
    expect(sup.getStatus()).toBe("disconnected");
  });

  it("does not restart the child after an intentional stop", async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const spawn: SpawnFn = vi.fn(() => {
      queueMicrotask(() => child.stdout.push(handshakeLine()));
      return child as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => socket);

    const sup = new SidecarSupervisor({ command: "fake", spawn, connect });
    await sup.start();
    await sup.stop();

    const spawnsAfterStop = (spawn as ReturnType<typeof vi.fn>).mock.calls.length;
    // Simulate a late exit event; must NOT trigger a respawn.
    child.exit(0);
    await new Promise((r) => setTimeout(r, 10));
    expect((spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(spawnsAfterStop);
  });
});

describe("SidecarSupervisor — ping when not connected", () => {
  it("returns ok:false without throwing", async () => {
    const sup = new SidecarSupervisor({ command: "fake", spawn: vi.fn(), connect: vi.fn() });
    const r = await sup.ping();
    expect(r).toEqual({ ok: false, latencyMs: 0 });
    expect(await sup.getHealth()).toBeNull();
  });
});

describe("SidecarSupervisor — notification fan-out (PRD-2)", () => {
  it("forwards sidecar notifications to onNotification subscribers", async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const spawn: SpawnFn = vi.fn(() => {
      queueMicrotask(() => child.stdout.push(handshakeLine()));
      return child as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => socket);

    const sup = new SidecarSupervisor({ command: "fake", spawn, connect });
    const received: Array<{ event: string; data: unknown }> = [];
    const unsub = sup.onNotification((event, data) => received.push({ event, data }));

    await sup.start();

    const segment = {
      meetingId: "00000000-0000-4000-8000-000000000000",
      source: "mic",
      text: "hello",
      tStart: 0,
      tEnd: 1,
      status: "final",
      segId: "seg-1",
    };
    socket.notify("transcriptSegment", segment);

    expect(received).toEqual([{ event: "transcriptSegment", data: segment }]);

    // Unsubscribe stops further delivery.
    unsub();
    socket.notify("transcriptSegment", segment);
    expect(received).toHaveLength(1);
  });

  it("does not let a throwing listener break supervision", async () => {
    const child = new FakeChild();
    const socket = new FakeSocket();
    const spawn: SpawnFn = vi.fn(() => {
      queueMicrotask(() => child.stdout.push(handshakeLine()));
      return child as unknown as ReturnType<SpawnFn>;
    });
    const connect = vi.fn(async () => socket);

    const sup = new SidecarSupervisor({ command: "fake", spawn, connect });
    sup.onNotification(() => {
      throw new Error("listener boom");
    });
    const ok: unknown[] = [];
    sup.onNotification((_e, d) => ok.push(d));

    await sup.start();
    expect(() => socket.notify("transcriptSegment", { x: 1 })).not.toThrow();
    expect(ok).toEqual([{ x: 1 }]);
    expect(sup.getStatus()).toBe("connected");
  });
});
