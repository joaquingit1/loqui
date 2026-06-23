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
  GetTranscriptParams,
  Health,
  ListMeetingsQuery,
  LoquiAudioApi,
  Meeting,
  MeetingSearchHit,
  MeetingStatusEvent,
  RenameMeetingParams,
  ScreenPermissionStatus,
  StartMeetingParams,
  StopMeetingParams,
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
  /** Meeting lifecycle + Library bridge (PRD-3). */
  library: LoquiLibraryApi;
}

/**
 * Meeting lifecycle + Library surface (PRD-3). Wraps the lifecycle/library IPC
 * channels so the renderer never references channel names directly.
 */
export interface LoquiLibraryApi {
  /** Start a meeting (status "recording"). */
  startMeeting(params?: StartMeetingParams): Promise<Meeting>;
  /** Stop a meeting (status "processing"/"done"). */
  stopMeeting(params: StopMeetingParams): Promise<Meeting>;
  /** List meetings with an optional date-range + full-text filter, newest-first. */
  listMeetings(query?: ListMeetingsQuery): Promise<Meeting[]>;
  /** Full-text search across title + transcript; returns hits with snippets. */
  searchMeetings(query: string): Promise<MeetingSearchHit[]>;
  /** Read a meeting's transcript file (default the live Markdown). */
  getTranscript(params: GetTranscriptParams): Promise<string>;
  /** Rename a meeting's title (persists to meta.json + index). */
  renameMeeting(params: RenameMeetingParams): Promise<Meeting>;
  /**
   * Subscribe to meeting lifecycle/status changes. The callback fires with the
   * full updated Meeting on each transition. Returns an unsubscribe fn.
   */
  onMeetingStatus(cb: (meeting: Meeting) => void): () => void;
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

const library: LoquiLibraryApi = {
  startMeeting: (params?: StartMeetingParams): Promise<Meeting> =>
    ipcRenderer.invoke(IPC.startMeeting, params),
  stopMeeting: (params: StopMeetingParams): Promise<Meeting> =>
    ipcRenderer.invoke(IPC.stopMeeting, params),
  listMeetings: (query?: ListMeetingsQuery): Promise<Meeting[]> =>
    ipcRenderer.invoke(IPC.listMeetingsQuery, query),
  searchMeetings: (query: string): Promise<MeetingSearchHit[]> =>
    ipcRenderer.invoke(IPC.searchMeetings, query),
  getTranscript: (params: GetTranscriptParams): Promise<string> =>
    ipcRenderer.invoke(IPC.getTranscript, params),
  renameMeeting: (params: RenameMeetingParams): Promise<Meeting> =>
    ipcRenderer.invoke(IPC.renameMeeting, params),
  onMeetingStatus: (cb: (meeting: Meeting) => void): (() => void) => {
    const listener = (_e: unknown, ev: MeetingStatusEvent): void => cb(ev.meeting);
    ipcRenderer.on(IPC.meetingStatus, listener);
    return () => ipcRenderer.removeListener(IPC.meetingStatus, listener);
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
  library,
};

contextBridge.exposeInMainWorld("loqui", api);
