/**
 * PRD-6 — the LOOPBACK-ONLY extension WebSocket server (main side).
 *
 * A NEW server in MAIN (distinct from the sidecar WS, where main is a client):
 * the browser extension's content script connects here and streams the Meet
 * active-speaker {@link import("@loqui/shared").ExtensionMessage} envelope
 * (hello / activity / bye). This module:
 *
 *   - binds {@link import("@loqui/shared").SPEAKERNAMES_WS_HOST} (127.0.0.1)
 *     ONLY — never 0.0.0.0 — on {@link import("@loqui/shared").SPEAKERNAMES_WS_PATH};
 *   - validates every inbound frame against the shared zod envelope and DROPS
 *     anything that does not parse (logged, never thrown);
 *   - BUFFERS {@link import("@loqui/shared").SpeakerActivityEvent}s ONLY while a
 *     Loqui meeting is recording (via the injected {@link ActiveMeetingSource}),
 *     keyed by the meeting id active at arrival time; IGNORES activity when no
 *     meeting is active;
 *   - tracks a connect/capture {@link import("@loqui/shared").SpeakerNamesStatus}
 *     for the renderer indicator and notifies subscribers on change;
 *   - hands a meeting's buffer to the correlation hook via `drainActivity`.
 *
 * #1 INVARIANT — GRACEFUL DEGRADATION: nothing here may throw into the meeting.
 * A bind failure (e.g. the port is busy) is logged and leaves the server inert
 * (status stays `disconnected`, every buffer empty) so the meeting completes
 * with generic `Speaker N` labels. The server NEVER touches the transcript.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  SPEAKERNAMES_WS_HOST,
  SPEAKERNAMES_WS_DEFAULT_PORT,
  SPEAKERNAMES_WS_PATH,
  MEET_ORIGIN,
  extensionMessageSchema,
  speakerNamesStatusSchema,
  type SpeakerActivityEvent,
  type SpeakerNamesStatus,
} from "@loqui/shared";
import type {
  ActiveMeetingSource,
  BufferedMeetingActivity,
  CreateExtensionWsServer,
  ExtensionWsServer,
  ExtensionWsServerDeps,
} from "./types.js";

/** Per-meeting accumulated activity (events in arrival order + distinct names). */
interface MeetingBuffer {
  events: SpeakerActivityEvent[];
  /** Distinct names seen, insertion-ordered (a Set preserves first-seen order). */
  names: Set<string>;
}

/**
 * Construct the loopback extension WS server. The listener is bound by
 * {@link ExtensionWsServer.start} (so a bind failure is awaitable + swallowable
 * by the caller); construction itself never touches the network.
 */
export const createExtensionWsServer: CreateExtensionWsServer = (
  deps: ExtensionWsServerDeps,
): ExtensionWsServer => {
  const { activeMeeting } = deps;
  const port = deps.port ?? SPEAKERNAMES_WS_DEFAULT_PORT;

  let wss: WebSocketServer | null = null;
  /** Open sockets, so stop() can drop them all. */
  const sockets = new Set<WebSocket>();
  /** Activity buffered per meeting id (only while that meeting was active). */
  const buffers = new Map<string, MeetingBuffer>();
  const statusListeners = new Set<(status: SpeakerNamesStatus) => void>();

  // Connection/capture state surfaced to the renderer. Defaults = "nothing
  // connected" (the all-defaults status). Mutated as sockets connect/disconnect
  // and as activity arrives; published via notifyStatus on change.
  let connections = 0;
  let lastEventAt: string | null = null;
  let selectorVersion = "";
  let extensionVersion = "";

  /** The meeting id currently recording (per the injected source), or null. */
  function activeMeetingId(): string | null {
    try {
      return activeMeeting.getActiveMeeting()?.id ?? null;
    } catch {
      // The source must never break the server; treat a throw as "none active".
      return null;
    }
  }

  function bufferFor(meetingId: string): MeetingBuffer {
    let buf = buffers.get(meetingId);
    if (!buf) {
      buf = { events: [], names: new Set<string>() };
      buffers.set(meetingId, buf);
    }
    return buf;
  }

  /** Compute the high-level connection/capture state. */
  function computeStatus(): SpeakerNamesStatus {
    const meetingActive = activeMeetingId() !== null;
    const buffered = meetingActive
      ? (buffers.get(activeMeetingId() as string)?.events.length ?? 0)
      : 0;
    // `capturing` requires connected + an active meeting + activity actually
    // buffered for it (per the documented state meaning); merely connected with
    // an active meeting but no events yet is `connected`.
    let state: SpeakerNamesStatus["state"] = "disconnected";
    if (connections > 0)
      state = meetingActive && buffered > 0 ? "capturing" : "connected";
    return speakerNamesStatusSchema.parse({
      state,
      meetingActive,
      bufferedEvents: buffered,
      lastEventAt,
      selectorVersion,
      extensionVersion,
    });
  }

  function notifyStatus(): void {
    const status = computeStatus();
    for (const cb of statusListeners) {
      try {
        cb(status);
      } catch {
        /* a status listener throwing must not break the server */
      }
    }
  }

  /** Handle one inbound text/binary frame from a connected extension socket. */
  function handleFrame(raw: unknown): void {
    let parsedJson: unknown;
    try {
      const text =
        typeof raw === "string"
          ? raw
          : raw instanceof Buffer
            ? raw.toString("utf8")
            : Buffer.isBuffer(raw)
              ? (raw as Buffer).toString("utf8")
              : String(raw);
      parsedJson = JSON.parse(text);
    } catch {
      return; // not JSON — drop, never throw.
    }

    const parsed = extensionMessageSchema.safeParse(parsedJson);
    if (!parsed.success) return; // malformed envelope — drop.
    const msg = parsed.data;

    if (msg.type === "hello") {
      // Record the extension/selector versions for the status indicator. The
      // meetingCode/origin are best-effort correlation aids (association is by
      // "active meeting + connected tab"), so we do not gate buffering on them.
      selectorVersion = msg.selectorVersion;
      extensionVersion = msg.extensionVersion;
      notifyStatus();
      return;
    }

    if (msg.type === "activity") {
      // IGNORE activity when no meeting is recording. This is the load-bearing
      // "loopback channel ignores events with no active meeting" invariant.
      const meetingId = activeMeetingId();
      if (meetingId === null) return;
      const event = msg.event;
      const buf = bufferFor(meetingId);
      buf.events.push(event);
      const name = event.name.trim();
      if (name !== "") buf.names.add(name);
      lastEventAt = new Date().toISOString();
      notifyStatus();
      return;
    }

    // "bye" — advisory only; the raw socket close is handled identically.
  }

  function onConnection(socket: WebSocket): void {
    sockets.add(socket);
    connections += 1;
    notifyStatus();

    socket.on("message", (data: unknown) => {
      try {
        handleFrame(data);
      } catch (err) {
        // Defense in depth: a handler bug must never crash the server.
        console.error("[loqui] speakernames: dropped frame on error:", err);
      }
    });
    const drop = (): void => {
      if (sockets.delete(socket)) {
        connections = Math.max(0, connections - 1);
        if (connections === 0) {
          // No extension connected: clear the echoed versions back to "unknown".
          selectorVersion = "";
          extensionVersion = "";
        }
        notifyStatus();
      }
    };
    socket.on("close", drop);
    socket.on("error", () => {
      // A socket error must not crash the server; close + drop it.
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
      drop();
    });
  }

  return {
    start(): Promise<{ host: string; port: number }> {
      if (wss) {
        const addr = wss.address() as AddressInfo;
        return Promise.resolve({ host: SPEAKERNAMES_WS_HOST, port: addr.port });
      }
      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        // LOOPBACK ONLY: bind 127.0.0.1 explicitly — never 0.0.0.0 / a public
        // host. The path pins the endpoint the extension dials.
        //
        // ORIGIN GATE (best-effort, defense in depth): loopback ports are
        // reachable by ANY browser tab (the same-origin policy does not block a
        // WebSocket to 127.0.0.1), so an arbitrary web page the user has open
        // could otherwise inject fabricated {name,speaking} events while a
        // meeting records and poison the correlation. The Meet content script
        // always sends an `Origin: https://meet.google.com` header on the
        // upgrade, so we REJECT any connection whose Origin is present and is
        // NOT MEET_ORIGIN. A missing Origin header is allowed (non-browser local
        // tooling / the smoke's bare `ws` client) so the channel still degrades
        // gracefully rather than breaking legitimate connections; the real
        // threat — a website tab — always carries its own Origin and is refused.
        const server = new WebSocketServer({
          host: SPEAKERNAMES_WS_HOST,
          port,
          path: SPEAKERNAMES_WS_PATH,
          verifyClient: (info: {
            origin?: string;
            req: { headers: { origin?: string } };
          }) => {
            try {
              const origin = info.origin ?? info.req.headers.origin;
              // Allow when no Origin header (non-browser client) or it matches.
              return origin === undefined || origin === MEET_ORIGIN;
            } catch {
              // A header-read failure must never crash the upgrade; allow +
              // degrade (worst case is the prior behavior, not a throw).
              return true;
            }
          },
        });
        const onError = (err: Error): void => {
          server.removeListener("listening", onListening);
          wss = null;
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          wss = server;
          server.on("connection", onConnection);
          // Subsequent runtime errors must not crash main.
          server.on("error", (err: Error) => {
            console.error("[loqui] speakernames WS server error:", err);
          });
          const addr = server.address() as AddressInfo;
          resolve({ host: addr.address, port: addr.port });
        };
        server.once("error", onError);
        server.once("listening", onListening);
      });
    },

    getStatus(): SpeakerNamesStatus {
      return computeStatus();
    },

    onStatusChange(cb: (status: SpeakerNamesStatus) => void): () => void {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },

    drainActivity(meetingId: string): BufferedMeetingActivity {
      const buf = buffers.get(meetingId);
      buffers.delete(meetingId);
      if (!buf) return { meetingId, events: [], participants: [] };
      notifyStatus();
      return {
        meetingId,
        events: buf.events,
        participants: [...buf.names],
      };
    },

    stop(): Promise<void> {
      const server = wss;
      wss = null;
      // Drop every open socket first so close handlers run + counts reset.
      for (const socket of [...sockets]) {
        try {
          socket.terminate();
        } catch {
          /* best-effort */
        }
      }
      sockets.clear();
      connections = 0;
      buffers.clear();
      selectorVersion = "";
      extensionVersion = "";
      lastEventAt = null;
      notifyStatus();
      if (!server) return Promise.resolve();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/**
 * Adapt the PRD-3 {@link import("../transcript/controller.js").MeetingController}
 * (or any object with `getActiveMeeting` + `onMeetingStatus`) to the
 * {@link ActiveMeetingSource} the WS server needs. The controller emits the full
 * Meeting on every status change; we surface only the "is a meeting recording?"
 * view: a `recording` meeting is the active one, anything else clears it.
 */
export function activeMeetingFromController(controller: {
  getActiveMeeting: ActiveMeetingSource["getActiveMeeting"];
  onMeetingStatus(cb: (meeting: import("@loqui/shared").Meeting) => void): () => void;
}): ActiveMeetingSource {
  return {
    getActiveMeeting: () => controller.getActiveMeeting(),
    onActiveMeetingChange(cb) {
      return controller.onMeetingStatus((meeting) => {
        cb(meeting.status === "recording" ? meeting : null);
      });
    },
  };
}
