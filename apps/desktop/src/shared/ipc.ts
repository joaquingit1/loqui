/**
 * IPC channel names shared between the Electron main process and the preload
 * script. The renderer never references these directly — it only sees the
 * typed `window.loqui` API exposed via contextBridge in src/preload/index.ts.
 *
 * `invoke`/`handle` channels are request/response; `sidecarStatus` is a
 * main → renderer push.
 */
export const IPC = {
  /** invoke: round-trip a ping through main → sidecar → back. */
  ping: "loqui:ping",
  /** invoke: fetch current sidecar health (or null). */
  getSidecarHealth: "loqui:getSidecarHealth",
  /** push (main → renderer): sidecar connection status changed. */
  sidecarStatus: "loqui:sidecarStatus",
  /** invoke: create a meeting. */
  createMeeting: "loqui:createMeeting",
  /** invoke: list meetings. */
  listMeetings: "loqui:listMeetings",
  /** invoke: get one meeting by id. */
  getMeeting: "loqui:getMeeting",
  /** invoke: patch a meeting. */
  updateMeeting: "loqui:updateMeeting",

  // --- Meeting lifecycle + Library (PRD-3) ---
  /** invoke: start a meeting (-> Meeting; status "recording"). */
  startMeeting: "loqui:startMeeting",
  /** invoke: stop a meeting (-> Meeting; status "processing"/"done"). */
  stopMeeting: "loqui:stopMeeting",
  /**
   * invoke: list meetings with an optional date-range + full-text filter
   * (payload {@link import("@loqui/shared").ListMeetingsQuery}; -> Meeting[]).
   */
  listMeetingsQuery: "loqui:listMeetingsQuery",
  /**
   * invoke: full-text search across title + transcript
   * (-> {@link import("@loqui/shared").MeetingSearchHit}[]).
   */
  searchMeetings: "loqui:searchMeetings",
  /**
   * invoke: read a meeting's transcript file
   * (payload {@link import("@loqui/shared").GetTranscriptParams}; -> string).
   */
  getTranscript: "loqui:getTranscript",
  /**
   * invoke: rename a meeting's title (persists to meta.json + index)
   * (payload {@link import("@loqui/shared").RenameMeetingParams}; -> Meeting).
   */
  renameMeeting: "loqui:renameMeeting",
  /**
   * push (main -> renderer): a meeting's lifecycle/status changed. Payload is a
   * {@link import("@loqui/shared").MeetingStatusEvent} carrying the full updated
   * Meeting; the renderer subscribes via `window.loqui.onMeetingStatus`.
   */
  meetingStatus: "loqui:meetingStatus",

  // --- Audio capture (PRD-1) ---
  /** invoke: begin a capture stream for one source (-> AudioCaptureResult). */
  audioStartCapture: "loqui:audio:startCapture",
  /** invoke: end a capture stream for one source (-> AudioCaptureResult). */
  audioStopCapture: "loqui:audio:stopCapture",
  /**
   * send (renderer → main, fire-and-forget hot path): one encoded binary audio
   * frame. Payload is an {@link import("@loqui/shared").AudioFrameMessage}; its
   * `frame` ArrayBuffer is structured-clone COPIED into main (ipcRenderer.send
   * cannot transfer; ~640 bytes/20 ms is negligible). NOT an invoke — no
   * per-frame round-trip.
   */
  audioFrame: "loqui:audio:frame",
  /** invoke: current screen-recording permission status (-> ScreenPermissionStatus). */
  audioGetScreenPermission: "loqui:audio:getScreenPermission",
  /** push (main → renderer): screen-recording permission status changed. */
  audioScreenPermission: "loqui:audio:screenPermission",

  // --- Transcription (PRD-2) ---
  /**
   * push (main → renderer): one {@link import("@loqui/shared").TranscriptSegment}.
   * The main process forwards every sidecar `transcriptSegment` WS notification
   * (see {@link import("@loqui/shared").TRANSCRIPT_SEGMENT_EVENT}) to the live
   * window on this channel; the renderer subscribes via
   * `window.loqui.onTranscriptSegment`. `partial` segments update in place and
   * are superseded by a later `final` with the same `segId`.
   */
  transcriptSegment: "loqui:transcriptSegment",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
