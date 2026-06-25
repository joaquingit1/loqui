/**
 * Hermetic tests for the loopback extension WS server (PRD-6).
 *
 * The server is bound on an OS-assigned loopback port (port 0) and driven by a
 * REAL in-process `ws` client over 127.0.0.1 — the ONLY network this test uses
 * is a 127.0.0.1 listener it asserts is loopback. No live Meet, no extension.
 *
 * Covers: binds 127.0.0.1 (never 0.0.0.0); buffers activity ONLY while a meeting
 * is active and IGNORES events when none is; drops malformed frames; distinct
 * names tracked; drainActivity returns + clears the buffer; status transitions
 * (disconnected -> connected -> capturing); stop() is clean + idempotent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  SPEAKERNAMES_WS_HOST,
  SPEAKERNAMES_WS_PATH,
  type ExtensionMessage,
  type Meeting,
  type SpeakerNamesStatus,
} from "@loqui/shared";
import {
  BROWSER_CALL_STALE_MS,
  createExtensionWsServer,
  activeMeetingFromController,
} from "./ws-server.js";
import type { ActiveMeetingSource, ExtensionWsServer } from "./types.js";

function meeting(id: string, status: Meeting["status"] = "recording"): Meeting {
  const now = "2026-06-24T00:00:00.000Z";
  return {
    id,
    title: "",
    platform: "google-meet",
    startedAt: now,
    endedAt: null,
    status,
    kind: "meeting",
    participants: [],
    modelVersions: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** A controllable active-meeting source for the server. */
function fakeActiveMeeting(): ActiveMeetingSource & { set(m: Meeting | null): void } {
  let active: Meeting | null = null;
  const cbs = new Set<(m: Meeting | null) => void>();
  return {
    set(m: Meeting | null) {
      active = m;
      for (const cb of cbs) cb(m);
    },
    getActiveMeeting: () => active,
    onActiveMeetingChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}

/** Connect a real ws client to the bound loopback port + path; resolve on open. */
function connect(port: number): Promise<WebSocket> {
  const url = `ws://${SPEAKERNAMES_WS_HOST}:${port}${SPEAKERNAMES_WS_PATH}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function send(ws: WebSocket, msg: ExtensionMessage | string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(typeof msg === "string" ? msg : JSON.stringify(msg), (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Poll a predicate until true (server processes frames asynchronously). */
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let server: ExtensionWsServer;
let port: number;
let source: ReturnType<typeof fakeActiveMeeting>;

beforeEach(async () => {
  source = fakeActiveMeeting();
  server = createExtensionWsServer({ activeMeeting: source, port: 0 });
  const addr = await server.start();
  port = addr.port;
});
afterEach(async () => {
  await server.stop();
});

describe("loopback binding", () => {
  it("binds 127.0.0.1 (loopback) and never 0.0.0.0", async () => {
    const fresh = createExtensionWsServer({
      activeMeeting: fakeActiveMeeting(),
      port: 0,
    });
    const addr = await fresh.start();
    try {
      expect(addr.host).toBe("127.0.0.1");
      expect(addr.host).not.toBe("0.0.0.0");
      expect(addr.port).toBeGreaterThan(0);
    } finally {
      await fresh.stop();
    }
  });
});

describe("origin gate (best-effort)", () => {
  it("accepts a connection from the Meet origin", async () => {
    const url = `ws://${SPEAKERNAMES_WS_HOST}:${port}${SPEAKERNAMES_WS_PATH}`;
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(url, { origin: "https://meet.google.com" });
      s.once("open", () => resolve(s));
      s.once("error", reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("accepts a connection with no Origin header (non-browser local tooling)", async () => {
    // The bare in-process client sends no Origin; the gate allows it so the
    // channel still degrades gracefully rather than refusing legitimate clients.
    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("REJECTS a connection from an arbitrary website origin (local-injection guard)", async () => {
    // A malicious/arbitrary tab on any site can reach a loopback port, but it
    // always carries its own Origin header — which is refused on the upgrade.
    const url = `ws://${SPEAKERNAMES_WS_HOST}:${port}${SPEAKERNAMES_WS_PATH}`;
    await expect(
      new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(url, { origin: "https://evil.example.com" });
        s.once("open", () => resolve(s));
        s.once("error", reject);
      }),
    ).rejects.toBeTruthy();
  });
});

describe("ignores events when no meeting is active", () => {
  it("drops activity while no meeting is recording; buffers once one starts", async () => {
    const ws = await connect(port);
    await send(ws, {
      type: "hello",
      extensionVersion: "1.0.0",
      selectorVersion: "2026-06-24",
      meetingCode: "abc-defg-hij",
      origin: "https://meet.google.com",
    });

    // No active meeting yet: this activity MUST be ignored.
    await send(ws, {
      type: "activity",
      event: { ts: 1000, name: "Alice", speaking: true },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.drainActivity("m1").events).toHaveLength(0);

    // Start a meeting; subsequent activity is buffered for it.
    source.set(meeting("m1"));
    await send(ws, {
      type: "activity",
      event: { ts: 2000, name: "Alice", speaking: true },
    });
    await send(ws, {
      type: "activity",
      event: { ts: 3000, name: "Bob", speaking: false },
    });
    await until(() => server.getStatus().bufferedEvents >= 2);

    const drained = server.drainActivity("m1");
    expect(drained.events.map((e) => e.name)).toEqual(["Alice", "Bob"]);
    expect(drained.participants).toEqual(["Alice", "Bob"]);
    // drainActivity clears the buffer.
    expect(server.drainActivity("m1").events).toHaveLength(0);
    ws.close();
  });

  it("buffers per the meeting active at arrival time", async () => {
    const ws = await connect(port);
    source.set(meeting("mA"));
    await send(ws, {
      type: "activity",
      event: { ts: 1000, name: "Alice", speaking: true },
    });
    await until(() => server.getStatus().bufferedEvents >= 1);
    // Rotate to a different meeting and capture for it.
    source.set(meeting("mB"));
    await send(ws, {
      type: "activity",
      event: { ts: 2000, name: "Bob", speaking: true },
    });
    await until(() => server.getStatus().bufferedEvents >= 1);

    // mA captured Alice; mB captured Bob — buffers are keyed per meeting.
    const a = server.drainActivity("mA");
    const b = server.drainActivity("mB");
    expect(a.events.map((e) => e.name)).toEqual(["Alice"]);
    expect(b.events.map((e) => e.name)).toEqual(["Bob"]);
    ws.close();
  });
});

describe("malformed frames are dropped (graceful degradation)", () => {
  it("non-JSON and bad-envelope frames never throw or buffer", async () => {
    const ws = await connect(port);
    source.set(meeting("m1"));
    await send(ws, "not json at all");
    await send(ws, JSON.stringify({ type: "nope", foo: 1 }));
    await send(ws, JSON.stringify({ no: "type" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(server.drainActivity("m1").events).toHaveLength(0);
    // The socket survived (server didn't crash) — a valid frame still works.
    await send(ws, {
      type: "activity",
      event: { ts: 1000, name: "Alice", speaking: true },
    });
    await until(() => server.getStatus().bufferedEvents >= 1);
    ws.close();
  });
});

describe("connection / capture status", () => {
  it("transitions disconnected -> connected -> capturing and back", async () => {
    const statuses: SpeakerNamesStatus["state"][] = [];
    const off = server.onStatusChange((s) => statuses.push(s.state));
    expect(server.getStatus().state).toBe("disconnected");

    const ws = await connect(port);
    await until(() => server.getStatus().state === "connected");
    await send(ws, {
      type: "hello",
      extensionVersion: "9.9",
      selectorVersion: "2026-06-24",
      meetingCode: null,
      origin: "https://meet.google.com",
    });
    // Wait for the hello frame to be processed (versions populated).
    await until(() => server.getStatus().extensionVersion === "9.9");
    expect(server.getStatus().selectorVersion).toBe("2026-06-24");

    // Start a meeting -> capturing once activity arrives.
    source.set(meeting("m1"));
    await send(ws, {
      type: "activity",
      event: { ts: 1000, name: "Alice", speaking: true },
    });
    await until(() => server.getStatus().state === "capturing");
    expect(server.getStatus().lastEventAt).not.toBeNull();

    ws.close();
    await until(() => server.getStatus().state === "disconnected");
    expect(server.getStatus().extensionVersion).toBe("");
    off();
  });
});

describe("lifecycle", () => {
  it("stop() is idempotent and clears buffers", async () => {
    source.set(meeting("m1"));
    const ws = await connect(port);
    await send(ws, { type: "activity", event: { ts: 1, name: "Alice", speaking: true } });
    await until(() => server.getStatus().bufferedEvents >= 1);
    await server.stop();
    await server.stop(); // idempotent — no throw.
    expect(server.getStatus().state).toBe("disconnected");
    expect(server.drainActivity("m1").events).toHaveLength(0);
  });
});

describe("activeMeetingFromController adapter", () => {
  it("surfaces a recording meeting and clears it on a non-recording status", () => {
    let active: Meeting | null = meeting("m1", "recording");
    let cb: ((m: Meeting) => void) | null = null;
    const controller = {
      getActiveMeeting: () => active,
      onMeetingStatus(fn: (m: Meeting) => void) {
        cb = fn;
        return () => {
          cb = null;
        };
      },
    };
    const src = activeMeetingFromController(controller);
    expect(src.getActiveMeeting()?.id).toBe("m1");

    const seen: Array<string | null> = [];
    src.onActiveMeetingChange((m) => seen.push(m?.id ?? null));
    cb!(meeting("m1", "recording")); // recording => active
    cb!(meeting("m1", "processing")); // not recording => cleared
    active = null;
    expect(seen).toEqual(["m1", null]);
  });
});

describe("browser in-call signal (PRD-11) — flows over the EXISTING WS", () => {
  it("is false with no extension connected", () => {
    expect(server.getBrowserCallState().inCall).toBe(false);
  });

  it("goes in-call on activity (even with NO active Loqui meeting) and notifies", async () => {
    const seen: boolean[] = [];
    server.onBrowserCallChange((s) => seen.push(s.inCall));
    const ws = await connect(port);
    // No active meeting — the PRD-6 buffer ignores it, but the in-call signal
    // still fires so auto-record can decide whether to START a meeting.
    await send(ws, { type: "activity", event: { ts: 1000, name: "Alice", speaking: true } });
    await until(() => server.getBrowserCallState().inCall === true);
    expect(seen).toContain(true);
    expect(server.drainActivity("none").events).toHaveLength(0);
    ws.close();
  });

  it("goes in-call on a hello carrying a meeting code", async () => {
    const ws = await connect(port);
    await send(ws, {
      type: "hello",
      extensionVersion: "1.0.0",
      selectorVersion: "2026-06-24",
      meetingCode: "abc-defg-hij",
      origin: "https://meet.google.com",
    });
    await until(() => server.getBrowserCallState().inCall === true);
    ws.close();
  });

  it("treats an old browser in-call signal as stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const firstSeen = new Date("2026-06-24T00:00:00.000Z");
      vi.setSystemTime(firstSeen);
      const ws = await connect(port);
      await send(ws, { type: "activity", event: { ts: 1000, name: "Alice", speaking: true } });
      await new Promise((r) => setTimeout(r, 30));
      expect(server.getBrowserCallState().inCall).toBe(true);

      vi.setSystemTime(new Date(firstSeen.getTime() + BROWSER_CALL_STALE_MS + 1));
      expect(server.getBrowserCallState().inCall).toBe(false);
      ws.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the in-call signal on a `bye` frame", async () => {
    const ws = await connect(port);
    await send(ws, { type: "activity", event: { ts: 1000, name: "Alice", speaking: true } });
    await until(() => server.getBrowserCallState().inCall === true);
    await send(ws, { type: "bye", reason: "left" });
    await until(() => server.getBrowserCallState().inCall === false);
    ws.close();
  });

  it("clears the in-call signal when the last socket drops", async () => {
    const ws = await connect(port);
    await send(ws, { type: "activity", event: { ts: 1000, name: "Alice", speaking: true } });
    await until(() => server.getBrowserCallState().inCall === true);
    ws.close();
    await until(() => server.getBrowserCallState().inCall === false);
  });
});
