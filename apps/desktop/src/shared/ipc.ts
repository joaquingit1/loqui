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
   * invoke: permanently delete a meeting — removes its directory (transcripts,
   * audio, summary, diarized, hi-fi) + search-index rows (payload
   * {@link import("@loqui/shared").DeleteMeetingParams}; -> void). Refused while
   * the meeting is still recording.
   */
  deleteMeeting: "loqui:deleteMeeting",
  /**
   * push (main -> renderer): a meeting's lifecycle/status changed. Payload is a
   * {@link import("@loqui/shared").MeetingStatusEvent} carrying the full updated
   * Meeting; the renderer subscribes via `window.loqui.onMeetingStatus`.
   */
  meetingStatus: "loqui:meetingStatus",

  // --- File import (PRD-12) ---
  /**
   * invoke: transcribe an existing audio/video file (payload
   * {@link import("@loqui/shared").ImportFileParams} {filePath, title?}; ->
   * Meeting). Mints a `kind:"import"` meeting (status "processing"), hands the
   * file to the sidecar to decode + transcribe + diarize + summarize (reusing
   * the existing pipeline), and returns the created Meeting immediately.
   * Progress arrives via the existing {@link postProcessJob} jobUpdate channel;
   * the meeting transitions to "done" via {@link meetingStatus} when finished.
   */
  importFile: "loqui:importFile",
  /**
   * invoke: open a native file-picker for an audio/video file and, if one is
   * chosen, import it (-> Meeting | null; null when the dialog was cancelled).
   * The renderer cannot read absolute paths (Electron 33+), so the picker lives
   * in main; this is the one-click "Transcribe a file" entry point.
   */
  importFilePick: "loqui:importFilePick",

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
  /**
   * invoke (renderer → main): open System Settings at Privacy & Security ▸
   * Screen Recording via the deep link (macOS). Used by the in-meeting recovery
   * notice when the "They" (system) source is refused for lack of the grant.
   * No-op on non-macOS; never throws (failure surfaces as `ok:false`).
   */
  audioOpenScreenSettings: "loqui:audio:openScreenSettings",
  /**
   * push (main → renderer): the NATIVE system-audio capture's live level (macOS
   * system audio, captured by the Swift helper in main — PART-2 of the
   * system-audio fix). Payload `{ meetingId: string; level: number }` (0..1).
   * The renderer subscribes via `window.loqui.audio.onSystemLevel` to drive the
   * "They" level meter, since for `mode:"native"` the renderer never holds the
   * system-audio stream to meter it itself.
   */
  audioSystemLevel: "loqui:audio:systemLevel",
  /**
   * invoke (renderer → main): mute/unmute the NATIVE system-audio capture
   * (PART-2). Payload `{ meetingId: string; muted: boolean }`. While muted, main
   * drops the helper's PCM frames (nothing is transcribed/recorded for "They")
   * and pushes level 0. The renderer calls it via
   * `window.loqui.audio.setSystemMuted`.
   */
  audioSetSystemMuted: "loqui:audio:setSystemMuted",

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

  // --- AI chat + provider abstraction (PRD-4) ---
  /**
   * send (renderer -> main, fire-and-forget): begin a streaming chat completion.
   * Payload is a {@link import("@loqui/shared").ChatSendParams} ({chatId, meetingId,
   * messages, providerConfig}). NOT an invoke — the reply is the streamed
   * {@link chatStream} pushes correlated by `chatId`, terminated by a `done` or
   * `error` event. Main reads the BYOK key from the OS keychain and forwards a
   * `chatRequest` WS notification to the sidecar; the sidecar reads the
   * transcript READ-ONLY and streams tokens back. The AI never edits the
   * transcript — there is NO channel here that writes a transcript/meta file.
   */
  chatSend: "loqui:chat:send",
  /**
   * push (main -> renderer): one chat stream event — a
   * {@link import("@loqui/shared").ChatStreamEvent} (`token` | `done` | `error`),
   * forwarded from the sidecar's `chatToken`/`chatDone`/`chatError` WS
   * notifications and tagged with the originating `chatId`. The chat panel
   * subscribes via `window.loqui.chat.onStream`.
   */
  chatStream: "loqui:chat:stream",
  /** invoke: read the persisted provider settings (-> ProviderConfig). */
  chatGetProviderSettings: "loqui:chat:getProviderSettings",
  /** invoke: persist the provider settings (payload + -> ProviderConfig). */
  chatSetProviderSettings: "loqui:chat:setProviderSettings",
  /**
   * invoke: store/clear a provider's BYOK API key in the OS keychain via
   * Electron safeStorage (payload {@link import("@loqui/shared").SetApiKeyParams};
   * -> {@link import("@loqui/shared").ApiKeyStatus}). Never returns the key.
   */
  chatSetApiKey: "loqui:chat:setApiKey",
  /**
   * invoke: whether a BYOK key is currently stored for a provider (payload
   * {provider}; -> {@link import("@loqui/shared").ApiKeyStatus}). Never returns
   * the key itself.
   */
  chatGetApiKeyStatus: "loqui:chat:getApiKeyStatus",

  // --- Post-meeting diarization + AI summaries (PRD-5) ---
  /**
   * push (main -> renderer): one post-processing {@link import("@loqui/shared").JobEvent}
   * (a {@link import("@loqui/shared").JobUpdate} with kind "diarization" | "summary"),
   * forwarded from the sidecar's `jobUpdate` WS notifications so the UI can show
   * diarization/summary progress. The renderer subscribes via `window.loqui.postprocess.onJob`.
   */
  postProcessJob: "loqui:postprocess:job",
  /**
   * push (main -> renderer): one {@link import("@loqui/shared").SummaryToken} —
   * a live summary text delta forwarded from the sidecar's `summaryToken` WS
   * notifications, so the renderer can STREAM the summary as it generates. The
   * renderer subscribes via `window.loqui.postprocess.onSummaryToken` and reads
   * the final parsed summary on the summary `jobUpdate` "done".
   */
  summaryStream: "loqui:postprocess:summaryStream",
  /**
   * invoke: read a meeting's AI summary (payload
   * {@link import("@loqui/shared").GetSummaryParams}; -> Summary | null).
   * READ-ONLY; null when no summary has been generated.
   */
  getSummary: "loqui:postprocess:getSummary",
  /**
   * invoke: read a meeting's diarized transcript (payload
   * {@link import("@loqui/shared").GetDiarizedTranscriptParams}; ->
   * DiarizedTranscript | null). READ-ONLY; null when not yet diarized.
   */
  getDiarizedTranscript: "loqui:postprocess:getDiarizedTranscript",
  /**
   * invoke: rename a diarized speaker (payload
   * {@link import("@loqui/shared").RenameSpeakerParams}; -> DiarizedTranscript).
   * main rewrites the diarized files + meta.participants + re-indexes
   * (deterministic, NOT an AI write; never touches transcript.live.md).
   */
  renameSpeaker: "loqui:postprocess:renameSpeaker",
  /**
   * invoke: regenerate a meeting's summary (payload
   * {@link import("@loqui/shared").RegenerateSummaryParams}; -> void). Triggers a
   * summary-only postProcess run on the sidecar; progress arrives via {@link postProcessJob}.
   */
  regenerateSummary: "loqui:postprocess:regenerateSummary",
  /**
   * invoke: store/clear the Hugging Face token for gated pyannote weights in the
   * OS keychain via the safeStorage keystore (payload
   * {@link import("@loqui/shared").SetHfTokenParams}; ->
   * {@link import("@loqui/shared").HfTokenStatus}). Never returns the token.
   */
  setHfToken: "loqui:postprocess:setHfToken",
  /**
   * invoke: whether an HF token is currently stored (->
   * {@link import("@loqui/shared").HfTokenStatus}). Never returns the token.
   */
  getHfTokenStatus: "loqui:postprocess:getHfTokenStatus",
  /** invoke: persist the postprocess diarization engine preference. */
  setDiarizationBackend: "loqui:postprocess:setDiarizationBackend",
  /** invoke: read the postprocess diarization engine preference. */
  getDiarizationBackendStatus: "loqui:postprocess:getDiarizationBackendStatus",

  // The local MCP server (PRD-7) runs always-on with NO renderer surface — no
  // status/snippets IPC. It's spawned + managed entirely in main (see mcp/).

  // --- Calendar integration + Home/Today view (PRD-15) ---
  /**
   * invoke: today's scheduled events across all connected accounts, soonest-first,
   * de-duplicated (-> {@link import("@loqui/shared").CalendarEvent}[]). READ-ONLY:
   * reads scheduled events from the provider; never writes a calendar or a transcript.
   */
  calendarListToday: "loqui:calendar:listToday",
  /**
   * invoke: upcoming events within a window (payload
   * {@link import("@loqui/shared").ListUpcomingParams}; ->
   * {@link import("@loqui/shared").CalendarEvent}[]), soonest-first.
   */
  calendarListUpcoming: "loqui:calendar:listUpcoming",
  /**
   * invoke: run a provider's loopback-PKCE OAuth connect flow (payload {provider};
   * -> {@link import("@loqui/shared").CalendarConnectResult}). Opens the consent
   * page via shell.openExternal, captures the redirect on a one-shot 127.0.0.1
   * listener, exchanges the code, and stores tokens in the OS keychain. Tokens
   * never reach the renderer.
   */
  calendarConnect: "loqui:calendar:connect",
  /**
   * invoke: disconnect a provider account (payload
   * {@link import("@loqui/shared").CalendarDisconnectParams}; -> void). Clears the
   * keychain tokens; omitting `account` clears all accounts for the provider.
   */
  calendarDisconnect: "loqui:calendar:disconnect",
  /**
   * invoke: list connected accounts (->
   * {@link import("@loqui/shared").CalendarConnection}[] — provider/account/lastSyncAt).
   * Never returns token material.
   */
  calendarGetConnections: "loqui:calendar:getConnections",
  /**
   * invoke: force a re-sync across all connected accounts (->
   * {@link import("@loqui/shared").CalendarEvent}[], the refreshed set).
   */
  calendarRefresh: "loqui:calendar:refresh",
  /**
   * push (main -> renderer): the calendar event set changed (payload
   * {@link import("@loqui/shared").CalendarEvent}[]). The Home view subscribes via
   * `window.loqui.calendar.onUpdated`. Fires on poll-interval/on-focus re-sync +
   * manual refresh when the set changes.
   */
  calendarUpdated: "loqui:calendar:updated",

  // --- Export & interop (PRD-13) ---
  /**
   * invoke: export ONE meeting in ONE format (payload
   * {@link import("@loqui/shared").ExportMeetingParams}; ->
   * {@link import("@loqui/shared").ExportResult}). READ-ONLY over the canonical
   * transcript: builds a model from the diarized transcript (else the live
   * transcript) + summary and writes a NEW file under the export dir; it NEVER
   * mutates transcript.live.md.
   */
  exportMeeting: "loqui:export:meeting",

  // --- Auto-record on meeting detection + menubar/tray (PRD-11) ---
  /**
   * invoke: read the persisted auto-record + tray settings (->
   * {@link import("@loqui/shared").AutoRecordSettings}): the master switch,
   * on-detect policy (ask/auto), native/browser detection toggles, app allowlist,
   * auto-stop delay, silence timeout + countdown window, run-in-background, and
   * launch-at-login. Defaults preserve manual-only PRD-3 behavior (enabled:false).
   */
  autoRecordGetSettings: "loqui:autorecord:getSettings",
  /**
   * invoke: patch the auto-record + tray settings (payload
   * {@link import("@loqui/shared").UpdateAutoRecordSettings}; ->
   * {@link import("@loqui/shared").AutoRecordSettings}). Applies live: toggling
   * `enabled` starts/stops the detection engine; `launchAtLogin` calls
   * `app.setLoginItemSettings`. Never stops an in-progress recording.
   */
  autoRecordSetSettings: "loqui:autorecord:setSettings",
  /**
   * invoke: the current auto-record runtime state (->
   * {@link import("@loqui/shared").AutoRecordState}): phase, whether recording,
   * the detection source + resolved probe inputs, and any silence countdown.
   * READ-ONLY status.
   */
  autoRecordGetState: "loqui:autorecord:getState",
  /**
   * invoke: accept a pending `ask`-policy detection prompt — start the detected
   * meeting now via the PRD-3 lifecycle (-> void). No-op when nothing is pending.
   */
  autoRecordAcceptPending: "loqui:autorecord:acceptPending",
  /**
   * invoke: dismiss a pending `ask`-policy detection prompt WITHOUT starting
   * (-> void). No-op when nothing is pending.
   */
  autoRecordDismissPending: "loqui:autorecord:dismissPending",
  /**
   * push (main -> renderer): the auto-record runtime state changed (payload
   * {@link import("@loqui/shared").AutoRecordState}). The window badge + any
   * detection prompt subscribe via `window.loqui.autoRecord.onState`. Fires on
   * detection, start/stop, the silence countdown, and settings changes.
   */
  autoRecordStateChanged: "loqui:autorecord:stateChanged",

  // --- Packaging + custom GitHub auto-updater (PRD-8) ---
  /**
   * invoke: the current updater runtime state (->
   * {@link import("@loqui/shared").UpdaterState}): current version, phase, the
   * available version + notes, last-checked time, download progress, and any
   * error. READ-ONLY status.
   */
  updaterGetState: "loqui:updater:getState",
  /**
   * invoke: read the persisted updater settings (->
   * {@link import("@loqui/shared").UpdaterSettings}): auto-check (default on),
   * the interval, and auto-download. Defaults load forward.
   */
  updaterGetSettings: "loqui:updater:getSettings",
  /**
   * invoke: patch the updater settings (payload
   * {@link import("@loqui/shared").UpdateUpdaterSettings}; ->
   * {@link import("@loqui/shared").UpdaterSettings}). Applies live: toggling
   * `autoCheck` starts/stops the interval timer.
   */
  updaterSetSettings: "loqui:updater:setSettings",
  /**
   * invoke: check GitHub for an update NOW (on demand). Resolves with the
   * resulting {@link import("@loqui/shared").UpdaterState}. A no-update result is
   * a no-op; offline / rate-limit / partial-download fail safely (the installed
   * app is intact) and surface via the `error` field + the state push.
   */
  updaterCheckNow: "loqui:updater:checkNow",
  /**
   * invoke: apply a staged, verified update — quit the app and hand off to the
   * detached OS helper that swaps the bundle + relaunches the new version (->
   * void). No-op unless the phase is `ready`.
   */
  updaterQuitAndInstall: "loqui:updater:quitAndInstall",
  /**
   * push (main -> renderer): the updater runtime state changed (payload
   * {@link import("@loqui/shared").UpdaterState}). The Settings panel + the
   * "Update ready — restart to apply" prompt subscribe via
   * `window.loqui.updater.onState`. Fires on check start/finish, download
   * progress, ready, and errors.
   */
  updaterStateChanged: "loqui:updater:stateChanged",

  // --- "Meeting Detected" desktop popup (fires ~1 min before a calendar event) ---
  /**
   * push (main -> the NOTIFICATION window's renderer): a meeting is imminent.
   * Payload is a {@link import("@loqui/shared").CalendarEvent}. The frameless
   * always-on-top popup subscribes via `window.loqui.notifications.onMeetingDetected`.
   */
  notificationMeetingDetected: "loqui:notification:meetingDetected",
  /**
   * invoke (popup -> main): the user clicked "Join & Record" (payload: the event
   * id). Main opens the join link, brings the main window forward, and asks it to
   * start a recording prefilled from the event; the popup hides.
   */
  notificationJoin: "loqui:notification:join",
  /** invoke (popup -> main): the user dismissed the popup — hide the window. */
  notificationDismiss: "loqui:notification:dismiss",
  /**
   * push (main -> the MAIN window's renderer): start a recording with these
   * {@link import("@loqui/shared").StartMeetingParams}. Lets the popup's "Join &
   * Record" drive the SAME unified start+capture flow as Home/⌘N. The App
   * subscribes via `window.loqui.onStartRequest`.
   */
  meetingStartRequest: "loqui:meeting:startRequest",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
