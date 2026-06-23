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
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
