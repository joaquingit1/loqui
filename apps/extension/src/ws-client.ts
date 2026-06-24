/**
 * PRD-6 — the extension's loopback WS client.
 *
 * The content script's ONLY outbound channel: a browser `WebSocket` to the Loqui
 * app's loopback extension server. Host/port/path are pinned by @loqui/shared
 * ({@link SPEAKERNAMES_WS_HOST}:{@link SPEAKERNAMES_WS_DEFAULT_PORT}{@link SPEAKERNAMES_WS_PATH})
 * so the extension and the server agree on one endpoint. The wire payloads are the
 * validated {@link ExtensionMessage} envelope (hello/activity/bye).
 *
 * #1 INVARIANT — CONNECTION FAILURE IS SILENT + BEST-EFFORT. If Loqui isn't
 * running (connection refused) or the socket drops, `send` is a no-op and the
 * client retries quietly with backoff; it NEVER throws into the content script
 * and NEVER blocks Meet. No audio is ever sent — only name/speaking events.
 *
 * Tests exercise this against a fake in-process socket (no real network): the
 * `WebSocketCtor` dep is injectable.
 */
import type { ExtensionMessage } from "@loqui/shared";
import {
  SPEAKERNAMES_WS_HOST,
  SPEAKERNAMES_WS_DEFAULT_PORT,
  SPEAKERNAMES_WS_PATH,
} from "./contract.js";

/**
 * The minimal sender the content script drives. `send` enqueues an envelope
 * (dropped silently when the socket isn't open); `close` sends `bye` + closes.
 * Connection lifecycle (connect/backoff/reconnect) is internal + best-effort.
 */
export interface MeetEventSender {
  /** Enqueue/send one envelope; silently no-ops when not connected. Never throws. */
  send(message: ExtensionMessage): void;
  /** Send `bye` (best-effort) and close the socket. Idempotent. */
  close(reason?: string): void;
}

/**
 * SIGNATURE the Build unit implements: construct a {@link MeetEventSender} that
 * connects to the pinned loopback endpoint with quiet backoff. `WebSocketCtor`
 * is injectable so tests pass a fake (default: the global browser `WebSocket`).
 */
export type CreateMeetEventSender = (deps?: {
  WebSocketCtor?: typeof WebSocket;
  port?: number;
}) => MeetEventSender;

/** Backoff schedule (ms) for quiet reconnect attempts; clamps at the last value. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

/**
 * Cap on the pending-send queue while the socket is (re)connecting. Activity
 * frames are high-frequency and only valuable fresh, so we keep a bounded recent
 * window and drop the oldest beyond it rather than growing without bound. `hello`
 * is re-sent on each (re)connect regardless, so dropping queued frames never
 * loses the session handshake.
 */
const MAX_QUEUE = 256;

function buildUrl(port: number): string {
  return `ws://${SPEAKERNAMES_WS_HOST}:${port}${SPEAKERNAMES_WS_PATH}`;
}

/**
 * Resolve the WebSocket constructor: the injected one (tests), else the global
 * browser `WebSocket`. Returns null when neither exists (e.g. an exotic page
 * context) so the sender degrades to a silent no-op instead of throwing.
 */
function resolveCtor(injected?: typeof WebSocket): typeof WebSocket | null {
  if (injected) return injected;
  if (typeof WebSocket !== "undefined") return WebSocket;
  return null;
}

export const createMeetEventSender: CreateMeetEventSender = (deps) => {
  const WebSocketCtor = resolveCtor(deps?.WebSocketCtor);
  const port = deps?.port ?? SPEAKERNAMES_WS_DEFAULT_PORT;
  const url = buildUrl(port);

  /** Open socket, or null while down. */
  let socket: WebSocket | null = null;
  /** Frames queued while the socket is not OPEN; flushed on open. */
  let queue: ExtensionMessage[] = [];
  /** The latest `hello` seen, re-sent first on every (re)connect. */
  let lastHello: ExtensionMessage | null = null;
  /** Index into RECONNECT_BACKOFF_MS for the current attempt. */
  let backoffIndex = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once close() is called — stops all reconnects (idempotent teardown). */
  let closed = false;

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null || WebSocketCtor === null) return;
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    backoffIndex += 1;
  }

  function rawSend(message: ExtensionMessage): boolean {
    // OPEN === 1; guard for fakes that omit the constant.
    const openState = (WebSocketCtor as unknown as { OPEN?: number })?.OPEN ?? 1;
    if (!socket || socket.readyState !== openState) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      // A send race against a closing socket — treat as "not delivered".
      return false;
    }
  }

  function flushQueue(): void {
    // Re-announce the session first so main can (re)associate the tab.
    if (lastHello) rawSend(lastHello);
    if (queue.length === 0) return;
    const pending = queue;
    queue = [];
    for (const msg of pending) {
      if (!rawSend(msg)) {
        // Socket went away mid-flush — requeue the rest and stop.
        queue.push(msg);
      }
    }
  }

  function connect(): void {
    if (closed || socket || WebSocketCtor === null) return;
    let ws: WebSocket;
    try {
      ws = new WebSocketCtor(url);
    } catch {
      // Construction failed (refused/blocked) — retry quietly.
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      backoffIndex = 0;
      flushQueue();
    };
    ws.onmessage = () => {
      // The extension is send-only; ignore anything inbound.
    };
    ws.onerror = () => {
      // Errors are expected when Loqui isn't running. Stay silent; onclose
      // drives reconnect. Never propagate.
    };
    ws.onclose = () => {
      socket = null;
      if (!closed) scheduleReconnect();
    };
  }

  // Kick off the first connection attempt (silent if Loqui isn't running yet).
  connect();

  return {
    send(message: ExtensionMessage): void {
      try {
        if (closed) return;
        if (message.type === "hello") {
          // The handshake is re-sent first on every (re)connect via flushQueue,
          // so it's tracked separately and never queued (avoids a duplicate).
          lastHello = message;
          rawSend(message);
          if (!socket && reconnectTimer === null) connect();
          return;
        }
        if (rawSend(message)) return;
        // Not connected yet (or dropped): buffer a bounded recent window.
        queue.push(message);
        if (queue.length > MAX_QUEUE) {
          queue.splice(0, queue.length - MAX_QUEUE);
        }
        // Ensure a connection attempt is in flight when nothing is open.
        if (!socket && reconnectTimer === null) connect();
      } catch (err) {
        // Sending must never throw into the content script.
        console.warn("[loqui-extension] ws send degraded:", err);
      }
    },

    close(reason?: string): void {
      if (closed) return;
      closed = true;
      try {
        // Best-effort farewell so main can release the buffer promptly.
        rawSend({ type: "bye", reason: reason ?? "" });
      } catch {
        // ignore
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      queue = [];
      lastHello = null;
      const s = socket;
      socket = null;
      try {
        s?.close();
      } catch {
        // ignore a close race
      }
    },
  };
};
