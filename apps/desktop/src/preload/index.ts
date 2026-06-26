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
  ApiKeyStatus,
  AudioCaptureResult,
  AudioCaptureStartParams,
  AudioCaptureStopParams,
  AudioFrameMessage,
  AutoRecordSettings,
  AutoRecordState,
  UpdateAutoRecordSettings,
  CaptureCapability,
  CaptureSettings,
  ExportMeetingParams,
  ExportResult,
  UpdateCaptureSettings,
  CalendarConnection,
  CalendarConnectResult,
  CalendarEvent,
  CalendarProviderId,
  ListUpcomingParams,
  ChatProvider,
  ChatSendParams,
  ChatStreamEvent,
  DiarizedTranscript,
  DiarizationBackendStatus,
  GetDiarizedTranscriptParams,
  GetSummaryParams,
  GetTranscriptParams,
  Health,
  HfTokenStatus,
  JobEvent,
  SummaryToken,
  ListMeetingsQuery,
  McpConfigSnippet,
  McpStatus,
  LoquiAudioApi,
  Meeting,
  ImportFileParams,
  MeetingSearchHit,
  MeetingStatusEvent,
  ProviderConfig,
  RegenerateSummaryParams,
  RenameMeetingParams,
  RenameSpeakerParams,
  ScreenPermissionStatus,
  SetApiKeyParams,
  SetDiarizationBackendParams,
  SetHfTokenParams,
  SpeakerNamesStatus,
  StartMeetingParams,
  StopMeetingParams,
  Summary,
  TranscriptSegment,
  TranscriptionEngineInfo,
  TranscriptionSettings,
  UpdateTranscriptionSettings,
  UpdaterSettings,
  UpdaterState,
  UpdateUpdaterSettings,
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
  /** In-call AI chat + provider abstraction bridge (PRD-4). */
  chat: LoquiChatApi;
  /** Post-meeting diarization + AI summaries bridge (PRD-5). */
  postprocess: LoquiPostProcessApi;
  /** Local read-only MCP server lifecycle + config bridge (PRD-7). */
  mcp: LoquiMcpApi;
  /** Calendar integration + Home/Today view bridge (PRD-15). */
  calendar: LoquiCalendarApi;
  /** Google Meet speaker-name attribution status bridge (PRD-6). */
  speakerNames: LoquiSpeakerNamesApi;
  /** Auto-record on meeting detection + menubar/tray bridge (PRD-11). */
  autoRecord: LoquiAutoRecordApi;
  /** Export & interop bridge (PRD-13). */
  export: LoquiExportApi;
  /** Capture / privacy controls bridge (PRD-13). */
  privacy: LoquiPrivacyApi;
  /** Pluggable transcription-engine bridge (PRD-9). */
  transcription: LoquiTranscriptionApi;
  /** Packaging + custom GitHub auto-updater bridge (PRD-8). */
  updater: LoquiUpdaterApi;
}

/**
 * Updater surface (PRD-8). Wraps the updater IPC channels so the Settings panel +
 * the "Update ready — restart to apply" prompt never reference channel names
 * directly. The updater fetches a public GitHub `version.json`, semver-compares,
 * and (when newer) downloads + sha256-VERIFIES + stages the new bundle; nothing
 * here touches the installed app until `quitAndInstall`. Integrity (invariant #2):
 * downloads only public release assets, verified before any swap — no Loqui
 * server. `onState` returns an unsubscribe fn.
 */
export interface LoquiUpdaterApi {
  /** The current updater runtime state (version / phase / available / progress). */
  getState(): Promise<UpdaterState>;
  /** Read the persisted updater settings (auto-check, interval, auto-download). */
  getSettings(): Promise<UpdaterSettings>;
  /** Patch the updater settings; applies live (re-arms the check timer). */
  setSettings(patch: UpdateUpdaterSettings): Promise<UpdaterSettings>;
  /** Check GitHub for an update NOW; resolves with the resulting state. */
  checkNow(): Promise<UpdaterState>;
  /** Apply a staged, verified update — quit + relaunch into the new version. */
  quitAndInstall(): Promise<void>;
  /**
   * Subscribe to updater state changes (push). Fires on check start/finish,
   * download progress, ready, and errors. Returns an unsubscribe fn.
   */
  onState(cb: (state: UpdaterState) => void): () => void;
}

/**
 * Export & interop surface (PRD-13). Wraps the export IPC channels so the
 * renderer never references channel names directly. READ-ONLY over the canonical
 * transcript: `exportMeeting` builds a model from the diarized (else live)
 * transcript + summary and writes a NEW file under the export dir — it never
 * mutates transcript.live.md.
 */
export interface LoquiExportApi {
  /** Export one meeting in one format; resolves with the written path + size. */
  exportMeeting(params: ExportMeetingParams): Promise<ExportResult>;
  /**
   * Open the native folder-picker to choose + persist the export dir. Resolves
   * to the chosen absolute path, or null when cancelled.
   */
  pickExportDir(): Promise<string | null>;
}

/**
 * Capture / privacy controls surface (PRD-13). Reads + patches the non-secret
 * capture settings (content-protection toggle, audio-retention policy, per-app
 * audio filter, export dir) and reports the per-app system-audio capability +
 * decision. No secrets here.
 */
export interface LoquiPrivacyApi {
  /** Read the persisted capture/privacy settings. */
  getCaptureSettings(): Promise<CaptureSettings>;
  /** Patch the capture/privacy settings; applies content-protection immediately. */
  setCaptureSettings(patch: UpdateCaptureSettings): Promise<CaptureSettings>;
  /** The per-app system-audio capability probe + resolved capture mode. */
  getCaptureCapability(): Promise<CaptureCapability>;
}

/**
 * Pluggable transcription-engine surface (PRD-9). Reads + patches the persisted
 * engine/model/language settings and lists the selectable engines + their
 * availability on this OS/arch. The chosen engine takes effect for the NEXT
 * meeting (the sidecar reads it at launch). macOS-only engines are flagged so the
 * UI hides/disables them on Windows. No secrets here.
 */
export interface LoquiTranscriptionApi {
  /** Read the persisted transcription-engine settings. */
  getSettings(): Promise<TranscriptionSettings>;
  /** Patch the engine/model/language settings (takes effect next meeting). */
  setSettings(patch: UpdateTranscriptionSettings): Promise<TranscriptionSettings>;
  /** List the selectable engines + their availability on this OS/arch. */
  getEngines(): Promise<TranscriptionEngineInfo[]>;
}

/**
 * Google Meet speaker-name attribution surface (PRD-6). Wraps the speaker-names
 * IPC channels so the renderer indicator never references channel names directly.
 * STATUS-ONLY + best-effort: this reports whether the browser extension is
 * connected and capturing names for the active meeting — it cannot start a
 * capture, write a name, or touch a transcript (correlation + name-apply run in
 * main after diarization, reusing the PRD-5 rewrite path). The feature degrades
 * gracefully: a `disconnected` status is normal and the meeting still completes
 * with generic `Speaker N` labels; the indicator messaging makes that clear.
 */
export interface LoquiSpeakerNamesApi {
  /** Current extension-connection / name-capture status. */
  status(): Promise<SpeakerNamesStatus>;
  /**
   * Subscribe to extension status changes (connect/disconnect, capture
   * start/stop). The callback fires with the full current status. Returns an
   * unsubscribe fn.
   */
  onStatus(cb: (status: SpeakerNamesStatus) => void): () => void;
}

/**
 * Auto-record + menubar/tray surface (PRD-11). Wraps the auto-record IPC channels
 * so the Settings panel + window badge + detection prompt never reference channel
 * names directly. MANUAL-FIRST: auto-record is OFF by default and nothing here
 * blocks manual start/stop (that stays on `library.startMeeting`/`stopMeeting`).
 * Settings writes apply live (toggling `enabled` starts/stops detection;
 * `launchAtLogin` reflects to the OS). `onState` returns an unsubscribe fn.
 */
export interface LoquiAutoRecordApi {
  /** Read the persisted auto-record + tray settings. */
  getSettings(): Promise<AutoRecordSettings>;
  /** Patch the auto-record + tray settings; applies live (engine + login item). */
  setSettings(patch: UpdateAutoRecordSettings): Promise<AutoRecordSettings>;
  /** The current auto-record runtime state (phase / recording / countdown). */
  getState(): Promise<AutoRecordState>;
  /** Accept a pending `ask`-policy detection prompt (start the detected meeting). */
  acceptPending(): Promise<void>;
  /** Dismiss a pending `ask`-policy detection prompt without starting. */
  dismissPending(): Promise<void>;
  /**
   * Subscribe to auto-record state changes (push). Fires with the full current
   * state on detection, start/stop, the silence countdown, and settings changes.
   * Returns an unsubscribe fn.
   */
  onState(cb: (state: AutoRecordState) => void): () => void;
}

/**
 * Calendar surface (PRD-15). Wraps the calendar IPC channels so the Home view +
 * Calendar settings panel never reference channel names directly. READ-ONLY:
 * reads SCHEDULED events from Google/Microsoft/Zoom (no calendar writes) and
 * never writes a transcript. `connect` runs an in-app loopback-PKCE OAuth flow
 * in main; tokens land in the OS keychain and NEVER reach the renderer. Shape
 * matches the PRD-15 contract exactly; `onUpdated` returns an unsubscribe fn.
 */
export interface LoquiCalendarApi {
  /** Today's events across all connected accounts, soonest-first, de-duplicated. */
  listToday(): Promise<CalendarEvent[]>;
  /** Upcoming events within a window (withinHours/limit defaulted), soonest-first. */
  listUpcoming(params?: ListUpcomingParams): Promise<CalendarEvent[]>;
  /**
   * Connect a provider via the in-app OAuth flow (opens the system browser).
   * Resolves with whether a connection now exists + the linked account label.
   */
  connect(provider: CalendarProviderId): Promise<CalendarConnectResult>;
  /** Disconnect a provider account (clears keychain tokens); account omitted clears all. */
  disconnect(provider: CalendarProviderId, account?: string): Promise<void>;
  /** List connected accounts (provider/account/lastSyncAt). Never returns tokens. */
  getConnections(): Promise<CalendarConnection[]>;
  /** Force a re-sync across all connected accounts; resolves with the refreshed set. */
  refresh(): Promise<CalendarEvent[]>;
  /**
   * Subscribe to event-set changes (push). The callback fires with the full
   * current event set whenever it changes. Returns an unsubscribe fn.
   */
  onUpdated(cb: (events: CalendarEvent[]) => void): () => void;
}

/**
 * Local MCP server surface (PRD-7). Wraps the MCP IPC channels so the Settings
 * screen can show status, start/stop the app-managed server, and print
 * ready-to-paste agent config snippets. The server is STRICTLY READ-ONLY over
 * the meeting store — nothing here (or on the server) can modify a meeting.
 */
export interface LoquiMcpApi {
  /** Current app-managed MCP server status (running/transport/url/dataRoot). */
  status(): Promise<McpStatus>;
  /** Start the app-managed server (idempotent); resolves with the new status. */
  enable(): Promise<McpStatus>;
  /** Stop the app-managed server (idempotent); resolves with the new status. */
  disable(): Promise<McpStatus>;
  /**
   * Ready-to-paste agent config snippets (Claude Code / Claude Desktop / Codex)
   * pointing at the local standalone `loqui-mcp` bin.
   */
  getConfigSnippets(): Promise<McpConfigSnippet[]>;
  /** Subscribe to MCP server status changes. Returns an unsubscribe fn. */
  onStatus(cb: (status: McpStatus) => void): () => void;
}

/**
 * Post-meeting diarization + AI summaries surface (PRD-5). Wraps the
 * postprocess IPC channels so the renderer never references channel names
 * directly. READ-ONLY over the live transcript: nothing here writes
 * transcript.live.md. The summary is a separate AI-derived file; the diarized
 * transcript is a separate deterministic re-labeling; renames are main-driven.
 */
export interface LoquiPostProcessApi {
  /**
   * Subscribe to post-processing job progress (diarization + summary). The
   * callback fires once per sidecar {@link JobEvent} (kind "diarization" |
   * "summary") with its state/progress. Returns an unsubscribe fn.
   */
  onJob(cb: (job: JobEvent) => void): () => void;
  /**
   * Subscribe to the LIVE summary token stream. The callback fires once per
   * {@link SummaryToken} (meetingId + delta) while the summary job generates, so
   * the UI can stream the summary text in real time. Returns an unsubscribe fn.
   */
  onSummaryToken(cb: (token: SummaryToken) => void): () => void;
  /** Read a meeting's AI summary, or null if not yet generated. */
  getSummary(params: GetSummaryParams): Promise<Summary | null>;
  /** Read a meeting's diarized transcript, or null if not yet diarized. */
  getDiarizedTranscript(
    params: GetDiarizedTranscriptParams,
  ): Promise<DiarizedTranscript | null>;
  /**
   * Rename a diarized speaker (e.g. "Speaker 1" -> "Alex"). Persists into the
   * diarized files + meta + index and returns the updated diarized transcript.
   */
  renameSpeaker(params: RenameSpeakerParams): Promise<DiarizedTranscript>;
  /**
   * Regenerate a meeting's summary (summary-only postProcess run). Fire-and-
   * forget; progress arrives on {@link LoquiPostProcessApi.onJob}.
   */
  regenerateSummary(params: RegenerateSummaryParams): Promise<void>;
  /**
   * Store (or clear, on an empty/null token) the Hugging Face token for gated
   * pyannote weights in the OS keychain. Never echoes the token; returns only
   * whether a token is now stored.
   */
  setHfToken(params: SetHfTokenParams): Promise<HfTokenStatus>;
  /** Whether an HF token is currently stored (never returns the token). */
  getHfTokenStatus(): Promise<HfTokenStatus>;
  /** Persist the preferred diarization engine. */
  setDiarizationBackend(
    params: SetDiarizationBackendParams,
  ): Promise<DiarizationBackendStatus>;
  /** Read the preferred diarization engine. */
  getDiarizationBackendStatus(): Promise<DiarizationBackendStatus>;
}

/**
 * In-call AI chat surface (PRD-4). Wraps the chat IPC channels so the renderer
 * never references channel names directly. READ-ONLY over the transcript: there
 * is no method here that writes a transcript/meta file — `send` only streams a
 * completion grounded in the (sidecar-read) transcript.
 */
export interface LoquiChatApi {
  /**
   * Begin a streaming chat completion (fire-and-forget). Returns nothing — the
   * reply arrives as a series of {@link ChatStreamEvent}s on
   * {@link LoquiChatApi.onStream}, correlated by `params.chatId` and terminated
   * by a `done` or `error` event. Main pulls the BYOK key from the OS keychain
   * and forwards the request to the sidecar; the renderer never handles the key.
   */
  send(params: ChatSendParams): void;
  /**
   * Subscribe to chat stream events for ALL in-flight chats. The callback fires
   * once per `token` / `done` / `error`; filter on `event.chatId` to route to
   * the right panel. Returns an unsubscribe fn.
   */
  onStream(cb: (event: ChatStreamEvent) => void): () => void;
  /** Read the persisted provider settings (provider/model/baseUrl/cli). */
  getProviderSettings(): Promise<ProviderConfig>;
  /** Persist the provider settings; takes effect on the next send (no restart). */
  setProviderSettings(config: ProviderConfig): Promise<ProviderConfig>;
  /**
   * Store (or clear, with an empty/null key) a provider's BYOK API key in the OS
   * keychain via Electron safeStorage. Never echoes the key back; returns only
   * whether a key is now stored.
   */
  setApiKey(params: SetApiKeyParams): Promise<ApiKeyStatus>;
  /** Whether a BYOK key is currently stored for a provider (never returns the key). */
  getApiKeyStatus(provider?: ChatProvider): Promise<ApiKeyStatus>;
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
   * Transcribe an existing audio/video file (PRD-12). Mints a `kind:"import"`
   * meeting (status "processing") and hands the file to the sidecar to decode +
   * transcribe + diarize + summarize via the existing pipeline. Returns the
   * created Meeting immediately; progress arrives via `postprocess.onJob` and the
   * meeting transitions to "done" via `onMeetingStatus`.
   */
  importFile(params: ImportFileParams): Promise<Meeting>;
  /**
   * Open the native file-picker and import the chosen audio/video file (PRD-12).
   * Resolves to the created `kind:"import"` Meeting, or null when cancelled. The
   * picker lives in main (the renderer cannot read absolute paths in Electron 33+).
   */
  pickAndImportFile(): Promise<Meeting | null>;
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
  importFile: (params: ImportFileParams): Promise<Meeting> =>
    ipcRenderer.invoke(IPC.importFile, params),
  pickAndImportFile: (): Promise<Meeting | null> => ipcRenderer.invoke(IPC.importFilePick),
  onMeetingStatus: (cb: (meeting: Meeting) => void): (() => void) => {
    const listener = (_e: unknown, ev: MeetingStatusEvent): void => cb(ev.meeting);
    ipcRenderer.on(IPC.meetingStatus, listener);
    return () => ipcRenderer.removeListener(IPC.meetingStatus, listener);
  },
};

const chat: LoquiChatApi = {
  send: (params: ChatSendParams): void => {
    // Fire-and-forget: the streamed reply rides the chatStream push, correlated
    // by chatId. No per-request round-trip (a long-lived token stream is not an
    // invoke). Main injects the keychain key before forwarding to the sidecar.
    ipcRenderer.send(IPC.chatSend, params);
  },
  onStream: (cb: (event: ChatStreamEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: ChatStreamEvent): void => cb(event);
    ipcRenderer.on(IPC.chatStream, listener);
    return () => ipcRenderer.removeListener(IPC.chatStream, listener);
  },
  getProviderSettings: (): Promise<ProviderConfig> =>
    ipcRenderer.invoke(IPC.chatGetProviderSettings),
  setProviderSettings: (config: ProviderConfig): Promise<ProviderConfig> =>
    ipcRenderer.invoke(IPC.chatSetProviderSettings, config),
  setApiKey: (params: SetApiKeyParams): Promise<ApiKeyStatus> =>
    ipcRenderer.invoke(IPC.chatSetApiKey, params),
  getApiKeyStatus: (provider?: ChatProvider): Promise<ApiKeyStatus> =>
    ipcRenderer.invoke(IPC.chatGetApiKeyStatus, provider),
};

const postprocess: LoquiPostProcessApi = {
  onJob: (cb: (job: JobEvent) => void): (() => void) => {
    const listener = (_e: unknown, job: JobEvent): void => cb(job);
    ipcRenderer.on(IPC.postProcessJob, listener);
    return () => ipcRenderer.removeListener(IPC.postProcessJob, listener);
  },
  onSummaryToken: (cb: (token: SummaryToken) => void): (() => void) => {
    const listener = (_e: unknown, token: SummaryToken): void => cb(token);
    ipcRenderer.on(IPC.summaryStream, listener);
    return () => ipcRenderer.removeListener(IPC.summaryStream, listener);
  },
  getSummary: (params: GetSummaryParams): Promise<Summary | null> =>
    ipcRenderer.invoke(IPC.getSummary, params),
  getDiarizedTranscript: (
    params: GetDiarizedTranscriptParams,
  ): Promise<DiarizedTranscript | null> =>
    ipcRenderer.invoke(IPC.getDiarizedTranscript, params),
  renameSpeaker: (params: RenameSpeakerParams): Promise<DiarizedTranscript> =>
    ipcRenderer.invoke(IPC.renameSpeaker, params),
  regenerateSummary: (params: RegenerateSummaryParams): Promise<void> =>
    ipcRenderer.invoke(IPC.regenerateSummary, params),
  setHfToken: (params: SetHfTokenParams): Promise<HfTokenStatus> =>
    ipcRenderer.invoke(IPC.setHfToken, params),
  getHfTokenStatus: (): Promise<HfTokenStatus> =>
    ipcRenderer.invoke(IPC.getHfTokenStatus),
  setDiarizationBackend: (
    params: SetDiarizationBackendParams,
  ): Promise<DiarizationBackendStatus> =>
    ipcRenderer.invoke(IPC.setDiarizationBackend, params),
  getDiarizationBackendStatus: (): Promise<DiarizationBackendStatus> =>
    ipcRenderer.invoke(IPC.getDiarizationBackendStatus),
};

const mcp: LoquiMcpApi = {
  status: (): Promise<McpStatus> => ipcRenderer.invoke(IPC.mcpStatus),
  enable: (): Promise<McpStatus> => ipcRenderer.invoke(IPC.mcpEnable),
  disable: (): Promise<McpStatus> => ipcRenderer.invoke(IPC.mcpDisable),
  getConfigSnippets: (): Promise<McpConfigSnippet[]> =>
    ipcRenderer.invoke(IPC.mcpGetConfigSnippets),
  onStatus: (cb: (status: McpStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: McpStatus): void => cb(status);
    ipcRenderer.on(IPC.mcpStatusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.mcpStatusChanged, listener);
  },
};

const calendar: LoquiCalendarApi = {
  listToday: (): Promise<CalendarEvent[]> => ipcRenderer.invoke(IPC.calendarListToday),
  listUpcoming: (params?: ListUpcomingParams): Promise<CalendarEvent[]> =>
    ipcRenderer.invoke(IPC.calendarListUpcoming, params),
  connect: (provider: CalendarProviderId): Promise<CalendarConnectResult> =>
    ipcRenderer.invoke(IPC.calendarConnect, { provider }),
  disconnect: (provider: CalendarProviderId, account?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.calendarDisconnect, { provider, account }),
  getConnections: (): Promise<CalendarConnection[]> =>
    ipcRenderer.invoke(IPC.calendarGetConnections),
  refresh: (): Promise<CalendarEvent[]> => ipcRenderer.invoke(IPC.calendarRefresh),
  onUpdated: (cb: (events: CalendarEvent[]) => void): (() => void) => {
    const listener = (_e: unknown, events: CalendarEvent[]): void => cb(events);
    ipcRenderer.on(IPC.calendarUpdated, listener);
    return () => ipcRenderer.removeListener(IPC.calendarUpdated, listener);
  },
};

const speakerNames: LoquiSpeakerNamesApi = {
  status: (): Promise<SpeakerNamesStatus> => ipcRenderer.invoke(IPC.speakerNamesStatus),
  onStatus: (cb: (status: SpeakerNamesStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: SpeakerNamesStatus): void => cb(status);
    ipcRenderer.on(IPC.speakerNamesStatusChanged, listener);
    return () => ipcRenderer.removeListener(IPC.speakerNamesStatusChanged, listener);
  },
};

const autoRecord: LoquiAutoRecordApi = {
  getSettings: (): Promise<AutoRecordSettings> =>
    ipcRenderer.invoke(IPC.autoRecordGetSettings),
  setSettings: (patch: UpdateAutoRecordSettings): Promise<AutoRecordSettings> =>
    ipcRenderer.invoke(IPC.autoRecordSetSettings, patch),
  getState: (): Promise<AutoRecordState> => ipcRenderer.invoke(IPC.autoRecordGetState),
  acceptPending: (): Promise<void> => ipcRenderer.invoke(IPC.autoRecordAcceptPending),
  dismissPending: (): Promise<void> => ipcRenderer.invoke(IPC.autoRecordDismissPending),
  onState: (cb: (state: AutoRecordState) => void): (() => void) => {
    const listener = (_e: unknown, state: AutoRecordState): void => cb(state);
    ipcRenderer.on(IPC.autoRecordStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.autoRecordStateChanged, listener);
  },
};

const exportApi: LoquiExportApi = {
  exportMeeting: (params: ExportMeetingParams): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.exportMeeting, params),
  pickExportDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.exportPickDir),
};

const transcription: LoquiTranscriptionApi = {
  getSettings: (): Promise<TranscriptionSettings> =>
    ipcRenderer.invoke(IPC.getTranscriptionSettings),
  setSettings: (patch: UpdateTranscriptionSettings): Promise<TranscriptionSettings> =>
    ipcRenderer.invoke(IPC.setTranscriptionSettings, patch),
  getEngines: (): Promise<TranscriptionEngineInfo[]> =>
    ipcRenderer.invoke(IPC.getTranscriptionEngines),
};

const privacy: LoquiPrivacyApi = {
  getCaptureSettings: (): Promise<CaptureSettings> =>
    ipcRenderer.invoke(IPC.getCaptureSettings),
  setCaptureSettings: (patch: UpdateCaptureSettings): Promise<CaptureSettings> =>
    ipcRenderer.invoke(IPC.setCaptureSettings, patch),
  getCaptureCapability: (): Promise<CaptureCapability> =>
    ipcRenderer.invoke(IPC.getCaptureCapability),
};

const updater: LoquiUpdaterApi = {
  getState: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC.updaterGetState),
  getSettings: (): Promise<UpdaterSettings> => ipcRenderer.invoke(IPC.updaterGetSettings),
  setSettings: (patch: UpdateUpdaterSettings): Promise<UpdaterSettings> =>
    ipcRenderer.invoke(IPC.updaterSetSettings, patch),
  checkNow: (): Promise<UpdaterState> => ipcRenderer.invoke(IPC.updaterCheckNow),
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke(IPC.updaterQuitAndInstall),
  onState: (cb: (state: UpdaterState) => void): (() => void) => {
    const listener = (_e: unknown, state: UpdaterState): void => cb(state);
    ipcRenderer.on(IPC.updaterStateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.updaterStateChanged, listener);
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
  chat,
  postprocess,
  mcp,
  calendar,
  speakerNames,
  autoRecord,
  export: exportApi,
  privacy,
  transcription,
  updater,
};

contextBridge.exposeInMainWorld("loqui", api);
