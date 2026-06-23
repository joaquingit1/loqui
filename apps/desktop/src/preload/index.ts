/**
 * Preload script. Exposes a typed, minimal API to the renderer via
 * contextBridge ONLY. No Node globals are leaked (contextIsolation: true,
 * nodeIntegration: false).
 *
 * STUB: the concrete API surface (ping round-trip, sidecar status, meeting
 * CRUD bridge) is implemented in the Build phase. The shape below is the
 * contract the renderer types against.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  AudioCaptureResult,
  AudioCaptureStartParams,
  AudioCaptureStopParams,
  AudioFrameMessage,
  Health,
  LoquiAudioApi,
  ScreenPermissionStatus,
  TranscriptSegment,
} from "@loqui/shared";
import { IPC } from "../shared/ipc.js";

export interface LoquiApi {
  /** Round-trips a ping main → sidecar → back. */
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
  /** Current sidecar health, or null if not connected. */
  getSidecarHealth(): Promise<Health | null>;
  /** Subscribe to sidecar status changes. Returns an unsubscribe fn. */
  onSidecarStatus(cb: (status: SidecarStatus) => void): () => void;
  /** Dual-stream audio capture bridge (PRD-1). */
  audio: LoquiAudioApi;
  /**
   * Subscribe to live transcript segments (PRD-2). The callback fires once per
   * sidecar-emitted {@link TranscriptSegment} (both `partial` and `final`).
   * `partial` segments update in place and are superseded by a later `final`
   * with the same `segId`; the two sources (`mic`="You", `system`="They") are
   * delivered independently and distinguished by `segment.source`. Returns an
   * unsubscribe fn.
   */
  onTranscriptSegment(cb: (segment: TranscriptSegment) => void): () => void;
}

export type SidecarStatus = "connecting" | "connected" | "disconnected" | "error";

const audio: LoquiAudioApi = {
  startCapture: (params: AudioCaptureStartParams): Promise<AudioCaptureResult> =>
    ipcRenderer.invoke(IPC.audioStartCapture, params),
  stopCapture: (params: AudioCaptureStopParams): Promise<AudioCaptureResult> =>
    ipcRenderer.invoke(IPC.audioStopCapture, params),
  sendFrame: (message: AudioFrameMessage): void => {
    // Fire-and-forget hot path. The ArrayBuffer is structured-clone copied into
    // main (no JSON/base64); a ~640-byte frame every 20 ms is negligible. Sent
    // on a dedicated channel (no per-frame invoke round-trip).
    ipcRenderer.send(IPC.audioFrame, {
      meetingId: message.meetingId,
      source: message.source,
      frame: message.frame,
    });
  },
  getScreenPermission: (): Promise<ScreenPermissionStatus> =>
    ipcRenderer.invoke(IPC.audioGetScreenPermission),
  onScreenPermission: (cb: (status: ScreenPermissionStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: ScreenPermissionStatus): void => cb(status);
    ipcRenderer.on(IPC.audioScreenPermission, listener);
    return () => ipcRenderer.removeListener(IPC.audioScreenPermission, listener);
  },
};

const api: LoquiApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  getSidecarHealth: () => ipcRenderer.invoke(IPC.getSidecarHealth),
  onSidecarStatus: (cb) => {
    const listener = (_e: unknown, status: SidecarStatus) => cb(status);
    ipcRenderer.on(IPC.sidecarStatus, listener);
    return () => ipcRenderer.removeListener(IPC.sidecarStatus, listener);
  },
  audio,
  onTranscriptSegment: (cb: (segment: TranscriptSegment) => void): (() => void) => {
    const listener = (_e: unknown, segment: TranscriptSegment): void => cb(segment);
    ipcRenderer.on(IPC.transcriptSegment, listener);
    return () => ipcRenderer.removeListener(IPC.transcriptSegment, listener);
  },
};

contextBridge.exposeInMainWorld("loqui", api);
