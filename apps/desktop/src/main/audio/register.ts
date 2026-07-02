/**
 * Audio-capture IPC registration (PRD-1 Foundation seam).
 *
 * Binds the `window.loqui.audio` bridge (see src/preload/index.ts) to the
 * sidecar supervisor: it forwards renderer-encoded binary frames onto the live
 * WS, drives the per-source `audioStart` / `audioStop` control notifications,
 * tracks the active meeting, and answers screen-recording permission queries.
 *
 * Channel names come from src/shared/ipc.ts (the single source). The renderer
 * never references channels directly — only the typed `window.loqui.audio` API.
 *
 * Start/stop and the binary-frame hot path are delegated to a
 * {@link CaptureOrchestrator}, which owns the per-(meeting,source) BOUNDED frame
 * queue + drop-oldest backpressure policy (PRD-1: "ring-buffer sizing
 * configurable; document the chosen defaults and the drop policy under load").
 * That is the path that actually runs — frames go renderer -> IPC ->
 * orchestrator.enqueueFrame -> (bounded queue, drop-oldest) -> supervisor.
 *
 * NOTE (scope): the Foundation wires the transport seam end-to-end (frame
 * forwarding, control frames, permission query). The Build units refine the
 * pieces a headless test cannot cover — registering
 * `session.setDisplayMediaRequestHandler(..., { audio: "loopback" })` at app
 * start, the device-picker, and the live permission-change watcher. Those hooks
 * are marked below.
 */
import {
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import {
  type AudioCaptureResult,
  type AudioCaptureStartParams,
  type AudioCaptureStopParams,
  type AudioFrameMessage,
  type ScreenPermissionStatus,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { SidecarSupervisor } from "../sidecar/supervisor.js";
import { CaptureOrchestrator } from "../capture/orchestrator.js";
import type {
  NativeFrameMessage,
  NativeSystemCapture,
} from "../capture/native-system-capture.js";

/** Human-readable refusal shown when the helper reports Screen Recording denied. */
const SCREEN_PERMISSION_REFUSAL =
  "Can’t capture system audio — macOS needs Screen Recording permission. " +
  "If a permission prompt just appeared, allow it, then quit and reopen Loqui. " +
  "Otherwise open System Settings → Privacy & Security → Screen Recording, enable Loqui, " +
  "then quit and reopen. Your microphone is still being recorded.";

/** The supervisor surface the audio layer needs (kept narrow for testability). */
export type AudioSupervisor = Pick<
  SidecarSupervisor,
  | "sendAudioFrame"
  | "sendControlNotification"
  | "setActiveMeeting"
  | "getActiveMeeting"
  | "isConnected"
>;

export interface AudioIpcDeps {
  supervisor: AudioSupervisor;
  /**
   * Resolve the current screen-recording permission status. Injected so the
   * handler stays headless-testable; production passes a fn that calls
   * Electron's `systemPreferences.getMediaAccessStatus("screen")` (macOS) or
   * returns "not-applicable" elsewhere.
   */
  getScreenPermission: () => ScreenPermissionStatus | Promise<ScreenPermissionStatus>;
  /**
   * Issue an APP-ATTRIBUTED Screen Recording request (macOS). TCC only shows
   * the permission prompt for a bundled app carrying
   * NSScreenCaptureUsageDescription — the bare capture-helper binary's
   * ScreenCaptureKit request is silently auto-denied (-3801) WITHOUT a prompt.
   * Production wires this to `desktopCapturer.getSources(...)` in main, which
   * is the app-level request that makes macOS actually ask; once granted, the
   * helper child inherits the app's grant. Best-effort: failures are expected
   * while the user answers the prompt.
   */
  requestScreenAccess?: () => Promise<void>;
  /**
   * Open System Settings at Privacy & Security ▸ Screen Recording (the recovery
   * deep link surfaced by the renderer when system audio is refused). Injected
   * so the handler stays headless-testable; production passes the capture
   * module's {@link import("../capture/permission.js").openScreenSettings}.
   * Optional — omitted in tests that don't exercise the recovery path.
   */
  openScreenSettings?: () => Promise<{ ok: boolean }>;
  /**
   * The capture orchestrator that owns the bounded per-source frame queue +
   * drop policy. Injectable for tests; defaults to a real
   * {@link CaptureOrchestrator} over the given supervisor.
   */
  orchestrator?: CaptureOrchestrator;
  /**
   * Factory for the NATIVE macOS system-audio capture (PART-2). When present AND
   * we are on darwin, a `source:"system"` start routes through the Swift helper
   * (main owns capture) instead of the renderer's `getDisplayMedia` (which is
   * Windows-only for loopback audio). The factory receives THIS registration's
   * orchestrator `enqueueFrame` so the injected frames take the SAME bounded-
   * queue hot path as renderer frames; index.ts supplies spawn/helperBin/
   * sendLevel. Omitted on non-mac / in tests that don't exercise native capture
   * -> the source falls back to the renderer path (`mode:"renderer"`).
   */
  makeNativeSystemCapture?: (
    enqueueFrame: (msg: NativeFrameMessage) => void,
  ) => NativeSystemCapture;
  /**
   * `process.platform`, injected so the darwin-only native-capture branch is
   * testable off-mac. Defaults to `process.platform`.
   */
  platform?: NodeJS.Platform;
}

/**
 * Register the audio invoke/send handlers. Returns a disposer that removes
 * them. Start/stop sequencing, active-meeting tracking, and the bounded
 * per-source frame queue all live in the {@link CaptureOrchestrator} so the
 * documented backpressure/drop policy is on the path that actually runs.
 */
export function registerAudioIpc(deps: AudioIpcDeps): () => void {
  const { supervisor, getScreenPermission } = deps;
  const platform = deps.platform ?? process.platform;
  const orchestrator =
    deps.orchestrator ??
    new CaptureOrchestrator({
      supervisor,
      // Audio is ALWAYS written during the meeting — the post-meeting hi-fi
      // re-transcription + diarization read the WAVs. They are deleted right
      // after post-processing finishes (see postprocess/pipeline.ts finalize),
      // so audio never persists, but it must exist transiently for that pass.
      getPersistAudio: () => true,
    });

  // Build the native system-audio capture (macOS only), wiring its frames to
  // THIS orchestrator's bounded-queue hot path (the same path renderer frames
  // take). Absent on non-mac / when no factory is injected.
  const nativeSystemCapture =
    platform === "darwin" && deps.makeNativeSystemCapture
      ? deps.makeNativeSystemCapture((msg) => orchestrator.enqueueFrame(msg))
      : undefined;

  /** Whether this start/stop should be served by the native (main-owned) helper. */
  const isNativeSystem = (source: AudioCaptureStartParams["source"]): boolean =>
    source === "system" && platform === "darwin" && nativeSystemCapture !== undefined;

  ipcMain.handle(
    IPC.audioStartCapture,
    async (
      _e: IpcMainInvokeEvent,
      params: AudioCaptureStartParams,
    ): Promise<AudioCaptureResult> => {
      // macOS system audio ("They") is captured NATIVELY by the Swift helper in
      // main — Electron's getDisplayMedia loopback audio is Windows-only, so the
      // renderer path never worked on macOS. Route it here (mic + Windows system
      // still use the renderer path and get mode:"renderer").
      if (isNativeSystem(params.source)) {
        return startNativeSystem(params);
      }
      // The orchestrator validates params, checks connectivity, sends
      // audioStart BEFORE any frames, and marks the meeting active.
      const result = orchestrator.start(params);
      // Tell the renderer it still owns capture for this source (mic everywhere;
      // system on Windows via getDisplayMedia loopback).
      return result.ok ? { ...result, mode: "renderer" } : result;
    },
  );

  /**
   * Start the native system-audio capture ATTEMPT-FIRST: drive the
   * orchestrator's control frames (audioStart), then spawn the helper. Returns
   * `mode:"native"` on success so the renderer skips getDisplayMedia. On
   * failure, tears the orchestrator source back down.
   *
   * There is deliberately NO up-front Screen Recording gate: on macOS,
   * `getMediaAccessStatus("screen")` reads "denied" even for an app that has
   * NEVER been asked (boolean CGPreflight under the hood), and the OS prompt
   * only fires from an actual ScreenCaptureKit attempt. Refusing early would
   * make it impossible for macOS to ever show the prompt. The helper's
   * SCShareableContent call triggers the prompt when never-asked and fails
   * with `capture_denied` (-3801) when truly denied — that failure is the ONE
   * authoritative refusal signal.
   */
  async function startNativeSystem(
    params: AudioCaptureStartParams,
  ): Promise<AudioCaptureResult> {
    // 0) If Screen Recording isn't granted yet, make the APP itself request it
    //    first. macOS only shows the Screen Recording prompt for a bundled app
    //    with a usage description — the helper (a bare binary) is auto-denied
    //    WITHOUT a prompt. This app-level request (desktopCapturer.getSources in
    //    production) is what finally makes macOS ask; the grant then covers the
    //    helper child. Best-effort: while the user answers the prompt this call
    //    fails/returns empty, and the attempt below surfaces the guided refusal.
    if (deps.requestScreenAccess) {
      const perm = await getScreenPermission();
      if (perm !== "granted" && perm !== "not-applicable") {
        try {
          await deps.requestScreenAccess();
        } catch {
          /* expected while unanswered/denied — the helper attempt decides */
        }
      }
    }
    // 1) Orchestrator sends audioStart + marks the meeting active (so the
    //    injected frames are accepted on the hot path).
    const started = orchestrator.start(params);
    if (!started.ok) return started;
    // 2) Spawn the helper + await captureReady. On a never-asked system this
    //    attempt is what makes macOS show the Screen Recording prompt.
    const native = await nativeSystemCapture!.start(params.meetingId);
    if (!native.ok) {
      // LOUD refusal: log the helper's failure code (+ the OS permission status
      // for context) so diagnosis is never blind. Covers capture_denied AND the
      // captureReady timeout / other helper failures.
      const perm = await getScreenPermission();
      console.warn(
        `[loqui] system-audio capture refused: native helper failed ` +
          `(code=${native.code ?? "capture_failed"}, screen permission="${perm}")`,
      );
      // Roll back the orchestrator source (sends audioStop, clears active if last).
      orchestrator.stop(params);
      if (native.code === "capture_denied") {
        return {
          ok: false,
          code: "screen_permission_denied",
          message: SCREEN_PERMISSION_REFUSAL,
        };
      }
      return {
        ok: false,
        code: native.code ?? "capture_failed",
        message: native.message ?? "native system-audio capture failed to start",
      };
    }
    return { ok: true, mode: "native" };
  }

  ipcMain.handle(
    IPC.audioStopCapture,
    async (
      _e: IpcMainInvokeEvent,
      params: AudioCaptureStopParams,
    ): Promise<AudioCaptureResult> => {
      if (isNativeSystem(params.source)) {
        // Stop the helper FIRST so its remaining frames flush into the queue,
        // THEN orchestrator.stop drains that queue + sends audioStop.
        nativeSystemCapture!.stop();
      }
      // Flushes that source's queue, sends audioStop AFTER its frames, and
      // clears the active meeting only when the LAST source stops.
      return orchestrator.stop(params);
    },
  );

  // Hot path: one encoded binary frame, fire-and-forget. The renderer posts the
  // frame's ArrayBuffer to main via ipcRenderer.send (structured-clone copy);
  // it lands here as `{meetingId, source, frame}`. The orchestrator buffers it
  // in the per-source bounded queue (drop-oldest on overflow) and best-effort
  // drains to the WS; frames for a non-active meeting / unstarted source /
  // malformed bytes are dropped, never forwarded.
  const onFrame = (_e: IpcMainEvent, message: AudioFrameMessage): void => {
    orchestrator.enqueueFrame(message);
  };
  ipcMain.on(IPC.audioFrame, onFrame);

  ipcMain.handle(
    IPC.audioGetScreenPermission,
    async (): Promise<ScreenPermissionStatus> => {
      return getScreenPermission();
    },
  );

  // Deep-link to System Settings ▸ Screen Recording so the in-meeting recovery
  // notice has an actionable "Open Screen Recording settings" button. No-op
  // (ok:false) when no opener is injected (non-mac / tests).
  ipcMain.handle(IPC.audioOpenScreenSettings, async (): Promise<{ ok: boolean }> => {
    if (!deps.openScreenSettings) return { ok: false };
    return deps.openScreenSettings();
  });

  // Mute/unmute the NATIVE system-audio capture (PART-2). No-op when there is no
  // native capture (non-mac / renderer-owned system audio); the renderer already
  // drops frames on its side for the renderer path.
  ipcMain.handle(
    IPC.audioSetSystemMuted,
    async (
      _e: IpcMainInvokeEvent,
      params: { meetingId: string; muted: boolean },
    ): Promise<void> => {
      nativeSystemCapture?.setMuted(Boolean(params?.muted));
    },
  );

  return () => {
    ipcMain.removeHandler(IPC.audioStartCapture);
    ipcMain.removeHandler(IPC.audioStopCapture);
    ipcMain.removeHandler(IPC.audioGetScreenPermission);
    ipcMain.removeHandler(IPC.audioOpenScreenSettings);
    ipcMain.removeHandler(IPC.audioSetSystemMuted);
    ipcMain.removeListener(IPC.audioFrame, onFrame);
    // Stop any active native helper first, then flush + send audioStop for any
    // still-started source so the sidecar finalizes its WAVs, and clear active.
    nativeSystemCapture?.stop();
    orchestrator.stopAll();
  };
}

/**
 * Push a NATIVE system-audio level to the renderer on
 * {@link IPC.audioSystemLevel} (PART-2). Injected as the `sendLevel` dep of the
 * {@link NativeSystemCapture} so the "They" meter updates even though the
 * renderer never holds the system-audio stream. `getWindow` resolves the live
 * window at emit time so the push survives window recreation.
 */
export function makeSystemLevelPusher(
  getWindow: () => BrowserWindow | null,
): (meetingId: string, level: number) => void {
  return (meetingId: string, level: number) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.audioSystemLevel, { meetingId, level });
    }
  };
}

/**
 * Push a screen-recording permission status change to the renderer on
 * {@link IPC.audioScreenPermission}. The Build unit's permission watcher calls
 * the returned `emit` fn when the OS-level grant changes. `getWindow` resolves
 * the live window at emit time so the push survives window recreation.
 */
export function makeScreenPermissionPusher(
  getWindow: () => BrowserWindow | null,
): (status: ScreenPermissionStatus) => void {
  return (status: ScreenPermissionStatus) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.audioScreenPermission, status);
    }
  };
}
