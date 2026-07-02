/**
 * Renderer ↔ main audio-capture bridge contract (PRD-1).
 *
 * This is the typed surface the preload exposes via contextBridge as
 * `window.loqui.audio` and the shapes that cross the renderer→main IPC for
 * audio capture. It is intentionally transport-agnostic at the type level: the
 * concrete IPC channel names live in apps/desktop/src/shared/ipc.ts, and the
 * binary PCM frames ride a dedicated `ipcRenderer.send` channel carrying an
 * `ArrayBuffer` (the already-encoded 16-byte-header + pcm_s16le frame from
 * {@link encodeAudioFrame}) — NOT JSON, to avoid base64/structured-clone of
 * large buffers.
 *
 * The two sources (mic = "You", system = "They") stay independent end-to-end:
 * every call is per-source and the main process keeps no shared mixing buffer.
 */
import type { AudioSource, CaptureMode } from "./audio.js";

/**
 * macOS Screen-Recording permission status for system/loopback capture.
 * Mirrors Electron's `systemPreferences.getMediaAccessStatus("screen")` plus a
 * platform-not-applicable case (Windows / Linux need no such grant).
 *
 * - `granted`        : capture allowed now.
 * - `denied`         : user explicitly denied; deep-link to System Settings.
 * - `restricted`     : blocked by policy (MDM); not user-recoverable.
 * - `not-determined` : never prompted; first capture will prompt.
 * - `not-applicable` : platform needs no screen-recording grant (non-macOS).
 */
export type ScreenPermissionStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "not-applicable";

/** Params to begin capturing one source for one meeting. */
export interface AudioCaptureStartParams {
  meetingId: string;
  source: AudioSource;
}

/** Params to stop capturing one source for one meeting. */
export interface AudioCaptureStopParams {
  meetingId: string;
  source: AudioSource;
}

/**
 * Result of a start/stop request, surfaced to the renderer. `ok:false` carries
 * a stable `code` the UI can branch on (e.g. show the permission recovery
 * flow) plus a human-readable `message`.
 */
export interface AudioCaptureResult {
  ok: boolean;
  /** Stable error code when `ok` is false (e.g. "no_active_meeting",
   *  "sidecar_unavailable", "screen_permission_denied"). */
  code?: string;
  message?: string;
  /**
   * Who owns capture for this source (see {@link CaptureMode}). `"native"` tells
   * the renderer that MAIN is already capturing this source (macOS system audio
   * via the Swift helper) and it MUST NOT call `getDisplayMedia`. Omitted /
   * `"renderer"` = the renderer captures the device as before. Only meaningful
   * on a successful `startCapture`.
   */
  mode?: CaptureMode;
}

/**
 * One binary audio frame as it crosses renderer→main. The renderer encodes the
 * frame with {@link encodeAudioFrame} (header + pcm_s16le) and transfers the
 * underlying `ArrayBuffer` over the dedicated frame channel. `source` is
 * redundant with the encoded header but is passed alongside so the main process
 * can route without decoding the header on the hot path.
 */
export interface AudioFrameMessage {
  meetingId: string;
  source: AudioSource;
  /** The encoded frame bytes (16-byte header + pcm_s16le payload). */
  frame: ArrayBuffer;
}

/**
 * The `window.loqui.audio` API the preload exposes. The Build unit
 * "renderer-capture" calls this; the Build unit "preload-audio-bridge"
 * implements it on top of the IPC channels.
 */
export interface LoquiAudioApi {
  /** Begin a capture stream for one source of the active meeting. */
  startCapture(params: AudioCaptureStartParams): Promise<AudioCaptureResult>;
  /** End a capture stream for one source. */
  stopCapture(params: AudioCaptureStopParams): Promise<AudioCaptureResult>;
  /**
   * Post one already-encoded binary frame to main (fire-and-forget; the hot
   * path). `frame` is the output of {@link encodeAudioFrame}; on the
   * renderer->main hop it is structured-clone COPIED (ipcRenderer.send cannot
   * transfer), so the copy is the main process's; the renderer may safely reuse
   * its own buffer. A ~640-byte frame every 20 ms makes the copy negligible.
   */
  sendFrame(message: AudioFrameMessage): void;
  /** Current screen-recording permission status (macOS-relevant). */
  getScreenPermission(): Promise<ScreenPermissionStatus>;
  /**
   * Subscribe to screen-recording permission changes (e.g. after the user
   * grants in System Settings). Returns an unsubscribe fn.
   */
  onScreenPermission(cb: (status: ScreenPermissionStatus) => void): () => void;
  /**
   * Open System Settings at Privacy & Security ▸ Screen Recording (macOS deep
   * link) so the user can grant the permission that gates system-audio capture.
   * No-op on non-macOS; never throws (a failure to open resolves `ok:false`).
   * Optional for the same additive reason as {@link LoquiAudioApi.onSystemLevel}
   * — an older bridge / test stub that predates it still satisfies the type.
   */
  openScreenSettings?(): Promise<{ ok: boolean }>;
  /**
   * Subscribe to the NATIVE system-audio capture's live level (macOS system
   * audio captured in main by the Swift helper — the `mode:"native"` path).
   * Fires ~10 Hz with the meeting id + a 0..1 level so the renderer can drive
   * the "They" meter without ever holding the system-audio stream. Returns an
   * unsubscribe fn. No-op / never fires on non-native (renderer-owned) capture.
   *
   * Optional on the type (additive PART-2 surface) so an older renderer bridge /
   * a test stub that predates it still satisfies {@link LoquiAudioApi}; the real
   * preload always implements it.
   */
  onSystemLevel?(cb: (payload: { meetingId: string; level: number }) => void): () => void;
  /**
   * Mute / unmute the NATIVE system-audio capture (macOS `mode:"native"`).
   * While muted, main drops the helper's frames (nothing is transcribed or
   * recorded for "They") and reports level 0. No-op when the system source is
   * not natively captured. Optional for the same additive reason as
   * {@link LoquiAudioApi.onSystemLevel}; the real preload always implements it.
   */
  setSystemMuted?(payload: { meetingId: string; muted: boolean }): Promise<void>;
}
