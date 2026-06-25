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

  // --- Local MCP server (PRD-7) ---
  /**
   * invoke: current app-managed MCP server status
   * (-> {@link import("@loqui/shared").McpStatus}). READ-ONLY server; this only
   * reports whether the managed process is up + how it's reachable.
   */
  mcpStatus: "loqui:mcp:status",
  /**
   * invoke: start the app-managed MCP server (-> {@link import("@loqui/shared").McpStatus}).
   * Idempotent — returns the running status if already up. The server is
   * strictly read-only over the meeting store.
   */
  mcpEnable: "loqui:mcp:enable",
  /**
   * invoke: stop the app-managed MCP server
   * (-> {@link import("@loqui/shared").McpStatus}). Idempotent.
   */
  mcpDisable: "loqui:mcp:disable",
  /**
   * invoke: ready-to-paste agent config snippets for the standalone server
   * (-> {@link import("@loqui/shared").McpConfigSnippet}[]), one per
   * Claude Code / Claude Desktop / Codex, pointing at the local `loqui-mcp` bin.
   */
  mcpGetConfigSnippets: "loqui:mcp:getConfigSnippets",
  /**
   * push (main -> renderer): the MCP server status changed (payload
   * {@link import("@loqui/shared").McpStatus}). The Settings indicator subscribes
   * via `window.loqui.mcp.onStatus`.
   */
  mcpStatusChanged: "loqui:mcp:statusChanged",

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

  // --- Google Meet speaker-name attribution (PRD-6) ---
  /**
   * invoke: current extension-connection / name-capture status
   * (-> {@link import("@loqui/shared").SpeakerNamesStatus}). Reports whether the
   * browser extension is connected, whether names are being captured for the
   * active meeting, and the connected extension/selector versions. READ-ONLY
   * status only — this never writes anything. The whole feature degrades
   * gracefully: a `disconnected` status is normal and the meeting still
   * completes with generic `Speaker N` labels.
   */
  speakerNamesStatus: "loqui:speakerNames:status",
  /**
   * push (main -> renderer): the speaker-names extension status changed (payload
   * {@link import("@loqui/shared").SpeakerNamesStatus}). The renderer indicator
   * subscribes via `window.loqui.speakerNames.onStatus`. Fires on
   * connect/disconnect of the extension WS and when capture starts/stops for the
   * active meeting.
   */
  speakerNamesStatusChanged: "loqui:speakerNames:statusChanged",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
