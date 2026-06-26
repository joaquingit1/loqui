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
   * The capture orchestrator that owns the bounded per-source frame queue +
   * drop policy. Injectable for tests; defaults to a real
   * {@link CaptureOrchestrator} over the given supervisor.
   */
  orchestrator?: CaptureOrchestrator;
}

/**
 * Register the audio invoke/send handlers. Returns a disposer that removes
 * them. Start/stop sequencing, active-meeting tracking, and the bounded
 * per-source frame queue all live in the {@link CaptureOrchestrator} so the
 * documented backpressure/drop policy is on the path that actually runs.
 */
export function registerAudioIpc(deps: AudioIpcDeps): () => void {
  const { supervisor, getScreenPermission } = deps;
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

  ipcMain.handle(
    IPC.audioStartCapture,
    async (
      _e: IpcMainInvokeEvent,
      params: AudioCaptureStartParams,
    ): Promise<AudioCaptureResult> => {
      // The orchestrator validates params, checks connectivity, sends
      // audioStart BEFORE any frames, and marks the meeting active.
      return orchestrator.start(params);
    },
  );

  ipcMain.handle(
    IPC.audioStopCapture,
    async (
      _e: IpcMainInvokeEvent,
      params: AudioCaptureStopParams,
    ): Promise<AudioCaptureResult> => {
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

  return () => {
    ipcMain.removeHandler(IPC.audioStartCapture);
    ipcMain.removeHandler(IPC.audioStopCapture);
    ipcMain.removeHandler(IPC.audioGetScreenPermission);
    ipcMain.removeListener(IPC.audioFrame, onFrame);
    // Flush + send audioStop for any still-started source so the sidecar
    // finalizes its WAVs, and clear the active meeting.
    orchestrator.stopAll();
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
