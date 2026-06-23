/**
 * The sidecar WS client. Owns a single WebSocket to the sidecar's loopback
 * control endpoint, correlates request/response by id, and exposes typed
 * `ping` / `getHealth` / `shutdown` calls. Server-initiated notifications are
 * surfaced via a callback so the supervisor can fan them out later (transcript
 * segments, job updates).
 *
 * The actual socket is injected through a tiny `RawSocket` abstraction so unit
 * tests can drive a fake socket with no real network. In production the
 * supervisor passes a `ws` WebSocket wrapped by {@link wrapWsSocket}.
 *
 * The per-launch token authenticates the connection itself: the supervisor
 * presents it in the WS URL query param (and Authorization header) at connect
 * time, so the sidecar rejects any socket that lacks it. The token is NOT
 * repeated inside each request envelope — the contract's `WsRequest` shape is
 * {type,id,method,params?} and the sidecar validates inbound frames against the
 * emitted `WsEnvelope` schema (additionalProperties:false), so an extra `token`
 * key would be rejected as an invalid frame.
 */
import {
  PROTOCOL_VERSION,
  healthSchema,
  pingResultSchema,
  wsEnvelopeSchema,
  type ControlMethod,
  type Health,
  type WsRequest,
} from "@loqui/shared";

/**
 * Minimal duck-typed socket the client drives. Matches the subset of the `ws`
 * WebSocket surface we use; a fake implementing this is enough for tests.
 */
export interface RawSocket {
  send(data: string): void;
  close(): void;
  /** Force-close without a handshake (maps to ws.terminate()). */
  terminate(): void;
  on(event: "message", cb: (data: unknown, isBinary?: boolean) => void): void;
  on(event: "close", cb: (code?: number, reason?: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "open", cb: () => void): void;
}

export interface SidecarClientOptions {
  /**
   * Per-launch auth token. Authenticates the WS connection at connect time
   * (presented in the URL by the supervisor); retained here for reference and
   * future use, but deliberately NOT embedded in request envelopes.
   */
  token: string;
  /** Default per-request timeout, in ms. */
  requestTimeoutMs?: number;
  /** Monotonic-ish clock for latency measurement (defaults to Date.now). */
  now?: () => number;
  /** Id generator for request correlation (defaults to an incrementing counter). */
  genId?: () => string;
  /** Called for every notification frame the sidecar pushes. */
  onNotification?: (event: string, data: unknown) => void;
  /** Called when the socket closes or errors (so the supervisor can react). */
  onClose?: (reason: string) => void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class SidecarClient {
  private readonly socket: RawSocket;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly onNotification?: (event: string, data: unknown) => void;
  private readonly onClose?: (reason: string) => void;

  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private closed = false;

  constructor(socket: RawSocket, opts: SidecarClientOptions) {
    this.socket = socket;
    this.token = opts.token;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.genId = opts.genId ?? (() => `req-${++this.counter}`);
    this.onNotification = opts.onNotification;
    this.onClose = opts.onClose;

    this.socket.on("message", (data: unknown) => this.handleMessage(data));
    this.socket.on("close", () => this.handleClose("socket closed"));
    this.socket.on("error", (err: Error) =>
      this.handleClose(`socket error: ${err.message}`),
    );
  }

  /** Round-trip a ping; resolves connectivity + measured latency in ms. */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const t0 = this.now();
    try {
      const result = await this.request("ping");
      const parsed = pingResultSchema.safeParse(result ?? {});
      const latencyMs = this.now() - t0;
      return { ok: parsed.success && parsed.data.pong === true, latencyMs };
    } catch {
      return { ok: false, latencyMs: this.now() - t0 };
    }
  }

  /** Fetch and validate the sidecar's health payload. */
  async getHealth(): Promise<Health> {
    const result = await this.request("getHealth");
    // Defaulted schema: tolerate a sparse payload but normalize it.
    return healthSchema.parse(result ?? {});
  }

  /** Ask the sidecar to begin a graceful shutdown. Best-effort. */
  async shutdown(): Promise<void> {
    await this.request("shutdown", undefined, 1_500);
  }

  /** Whether the protocol version we negotiate against matches the sidecar's. */
  static readonly protocolVersion = PROTOCOL_VERSION;

  /** Send a request envelope and await the correlated response. */
  request(
    method: ControlMethod,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("sidecar client is closed"));
    }
    const id = this.genId();
    // Contract WsRequest shape only: {type,id,method,params?}. The token is NOT
    // included — the connection is already token-authed and the sidecar rejects
    // unknown envelope keys (additionalProperties:false).
    const envelope: WsRequest = {
      type: "request",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${method}" (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't let a pending request keep the process alive.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(envelope));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Close the socket and reject any in-flight requests. */
  close(): void {
    this.handleClose("client closed by caller");
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }

  private handleMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof Buffer) {
      text = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString("utf8");
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    } else {
      // Unknown binary frame on the control channel; ignore (audio rides raw).
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return; // ignore non-JSON noise on the control channel
    }

    const parsed = wsEnvelopeSchema.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;

    switch (frame.type) {
      case "response": {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve(frame.result);
        return;
      }
      case "error": {
        if (frame.id === null) return;
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
        return;
      }
      case "notification": {
        this.onNotification?.(frame.event, frame.data);
        return;
      }
      case "request":
        // The sidecar never requests of the main process; ignore.
        return;
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`sidecar connection lost: ${reason}`));
    }
    this.pending.clear();
    this.onClose?.(reason);
  }
}
