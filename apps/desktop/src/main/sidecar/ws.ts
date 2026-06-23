/**
 * Production WebSocket plumbing for the sidecar client.
 *
 * Wraps the `ws` library behind the {@link RawSocket} abstraction the
 * {@link SidecarClient} drives, and connects to the sidecar's loopback control
 * endpoint presenting the per-launch token. Kept in its own module so the
 * supervisor's logic and the client can be unit-tested without `ws` or a real
 * socket.
 */
import { WebSocket } from "ws";
import type { RawSocket } from "./client.js";

/** Adapt a `ws` WebSocket to the {@link RawSocket} interface. */
export function wrapWsSocket(ws: WebSocket): RawSocket {
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    terminate: () => ws.terminate(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      ws.on(event, cb as (...a: unknown[]) => void);
    },
  } as RawSocket;
}

export interface ConnectOptions {
  port: number;
  token: string;
  /** Connection timeout in ms (default 5000). */
  timeoutMs?: number;
}

/**
 * Open a WS connection to ws://127.0.0.1:<port> presenting the token (both as
 * an Authorization header and a query param, so the sidecar can accept either),
 * and resolve once the socket is open. Rejects on error or timeout.
 */
export function connectWs(opts: ConnectOptions): Promise<WebSocket> {
  const { port, token, timeoutMs = 5_000 } = opts;
  const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      // Loopback only; never follow redirects off-host.
      followRedirects: false,
    });

    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`WS connect to 127.0.0.1:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    const onOpen = (): void => {
      cleanup();
      resolve(ws);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    function cleanup(): void {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    }

    ws.on("open", onOpen);
    ws.on("error", onError);
  });
}
