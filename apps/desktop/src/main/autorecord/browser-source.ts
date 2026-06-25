/**
 * PRD-11 — the browser in-call source for the auto-record engine.
 *
 * Browser meetings are NOT an OS probe — they ride the PRD-6 extension over the
 * EXISTING loopback WS server (no new socket). This thin adapter exposes the WS
 * server's collapsed "a browser tab is in a call" signal as the small
 * {@link BrowserCallSource} the engine depends on, so the engine never imports
 * the WS server directly (clean seam; tests inject a fake source).
 */
import type { BrowserCallState } from "@loqui/shared";

/** The minimal slice of the PRD-6 WS server the engine needs for browser detection. */
export interface BrowserCallSource {
  /** The current "is a browser tab in a call?" signal (best-effort). */
  getBrowserCallState(): BrowserCallState;
  /** Subscribe to in-call changes (enter/leave). Returns unsubscribe. */
  onBrowserCallChange(cb: (state: BrowserCallState) => void): () => void;
}

/**
 * Adapt the PRD-6 extension WS server (or any object exposing the browser-call
 * surface) to the {@link BrowserCallSource} the engine consumes. Identity-ish,
 * but pins the seam so the engine depends on the narrow interface, not the server.
 */
export function browserCallSourceFromWsServer(server: BrowserCallSource): BrowserCallSource {
  return {
    getBrowserCallState: () => server.getBrowserCallState(),
    onBrowserCallChange: (cb) => server.onBrowserCallChange(cb),
  };
}

/** A source that never reports an in-call browser tab — the disabled/test default. */
export function nullBrowserCallSource(): BrowserCallSource {
  return {
    getBrowserCallState: () => ({ inCall: false, lastSeenAt: null }),
    onBrowserCallChange: () => () => {},
  };
}
