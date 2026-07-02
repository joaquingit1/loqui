/**
 * System / loopback audio enablement for `getDisplayMedia` (PRD-1, unit
 * "main-capture-orchestration").
 *
 * Electron only returns a system-audio (loopback) track from the renderer's
 * `navigator.mediaDevices.getDisplayMedia({ audio: true, video: ... })` if the
 * MAIN process has registered a display-media request handler that calls the
 * callback with `{ audio: "loopback" }`. We register that handler on the
 * default session here.
 *
 * ## Platform reality: Electron loopback audio is WINDOWS-ONLY
 *
 * Electron's `{ audio: "loopback" }` system-audio path is backed by WASAPI
 * loopback and only produces a real system-audio track on **Windows**. On
 * **macOS** this handler does NOT yield usable system audio — the loopback
 * track is silent / the request effectively fails — so the renderer's
 * `getDisplayMedia` path can never capture "They" on macOS. macOS system audio
 * is instead captured NATIVELY in the main process by the Swift helper via
 * ScreenCaptureKit (see {@link import("./native-system-capture.js")}), which
 * injects it into the sidecar as `source:"system"` frames.
 *
 * We still register this handler because Windows needs it (and mic capture on
 * every platform rides `getUserMedia`, not this). On macOS, ScreenCaptureKit is
 * gated by the **Screen Recording** privacy permission (the SAME grant used for
 * screen video); the native-capture path pairs with
 * {@link import("./permission.js")} to detect the `denied` / `not-determined` /
 * needs-restart states and surface a recovery path. On Windows (WASAPI
 * loopback) and Linux, no such grant is required.
 *
 * ## Video constraint
 *
 * `getDisplayMedia` requires a video stream to be requested even when we only
 * want audio, and `setDisplayMediaRequestHandler` must therefore supply a
 * video source. We do NOT use the native system picker
 * (`useSystemPicker: false`) — the renderer requests the primary screen and
 * immediately drops the video track, keeping only the loopback audio track.
 * This path is exercised only on **Windows** (where loopback audio works); on
 * macOS the Swift helper's native ScreenCaptureKit tap (see
 * {@link import("./native-system-capture.js")}) captures audio without any
 * video request at all.
 *
 * The handler is built as a pure factory so its decision (audio loopback, video
 * source selection) is unit-testable without a real Electron session; the thin
 * `registerDisplayMediaLoopback(session)` wrapper is what main wires at startup.
 */
import type { Session, DesktopCapturerSource } from "electron";

/**
 * The subset of Electron's display-media callback streams object we populate.
 * Mirrors `Electron.Streams` structurally so we can build/test the callback
 * payload without importing the runtime.
 */
export interface DisplayMediaStreams {
  /** `"loopback"` enables system audio; omit/undefined disables it. */
  audio?: "loopback" | "loopbackWithMute";
  /** A desktop-capturer video source (required by the API even for audio-only). */
  video?: DesktopCapturerSource;
}

/** Options controlling how the loopback handler resolves the video source. */
export interface LoopbackHandlerOptions {
  /**
   * Resolve the video source the handler hands back. Defaults to `undefined`
   * (no specific source) — the renderer obtains the primary screen and drops
   * the video track. A Build unit / native-tap path can inject a real
   * `desktopCapturer` source here later.
   */
  resolveVideoSource?: () => DesktopCapturerSource | undefined;
  /**
   * If true, request loopback audio muted on the local speakers
   * (`"loopbackWithMute"`) — not used by default; the user still hears the call.
   */
  muteLocalPlayback?: boolean;
}

/**
 * Build the display-media request handler callback. Always enables loopback
 * audio (or `loopbackWithMute`) and attaches the resolved video source. Pure:
 * returns a function `(request, callback) => void` with no Electron runtime
 * dependency, so it is unit-testable by passing a fake `callback`.
 */
export function makeDisplayMediaLoopbackHandler(
  options: LoopbackHandlerOptions = {},
): (request: unknown, callback: (streams: DisplayMediaStreams) => void) => void {
  const audio = options.muteLocalPlayback ? "loopbackWithMute" : "loopback";
  const resolveVideo = options.resolveVideoSource;
  return (_request, callback) => {
    const video = resolveVideo ? resolveVideo() : undefined;
    const streams: DisplayMediaStreams = { audio };
    if (video) streams.video = video;
    callback(streams);
  };
}

/** Minimal session surface we need — keeps `registerDisplayMediaLoopback` testable. */
export type LoopbackSession = Pick<Session, "setDisplayMediaRequestHandler">;

/**
 * Register the loopback display-media handler on `session` so the renderer's
 * `getDisplayMedia` yields system audio. `useSystemPicker:false` keeps the MVP
 * flow headless-deterministic. See the file header for the macOS Screen-
 * Recording permission implication.
 *
 * @returns a disposer that clears the handler (passes `null`).
 */
export function registerDisplayMediaLoopback(
  session: LoopbackSession,
  options: LoopbackHandlerOptions = {},
): () => void {
  const handler = makeDisplayMediaLoopbackHandler(options);
  session.setDisplayMediaRequestHandler(
    handler as Parameters<Session["setDisplayMediaRequestHandler"]>[0],
    { useSystemPicker: false },
  );
  return () => {
    session.setDisplayMediaRequestHandler(null);
  };
}
