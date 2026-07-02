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
  ExportMeetingParams,
  ExportResult,
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
  LoquiAudioApi,
  Meeting,
  ImportFileParams,
  MeetingSearchHit,
  MeetingStatusEvent,
  ProviderConfig,
  RegenerateSummaryParams,
  RenameMeetingParams,
  DeleteMeetingParams,
  RenameSpeakerParams,
  ScreenPermissionStatus,
  SetApiKeyParams,
  SetDiarizationBackendParams,
  SetHfTokenParams,
  StartMeetingParams,
  StopMeetingParams,
  Summary,
  TranscriptSegment,
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
  /** Calendar integration + Home/Today view bridge (PRD-15). */
  calendar: LoquiCalendarApi;
  /** Auto-record on meeting detection + menubar/tray bridge (PRD-11). */
  autoRecord: LoquiAutoRecordApi;
  /** Export & interop bridge (PRD-13). */
  export: LoquiExportApi;
  /** Packaging + custom GitHub auto-updater bridge (PRD-8). */
  updater: LoquiUpdaterApi;
  /** "Meeting Detected" popup bridge (used by the notification window's renderer). */
  notifications: LoquiNotificationsApi;
  /**
   * Subscribe to a main-pushed "start a recording with these params" request,
   * fired when the user clicks "Join & Record" in the meeting popup. Drives the
   * SAME unified start+capture flow as Home / ⌘N. Returns an unsubscribe fn.
   */
  onStartRequest(cb: (params: StartMeetingParams) => void): () => void;
}

/**
 * Notification-window surface: the frameless "Meeting Detected" popup receives
 * the imminent meeting and acts on it. The popup never starts a recording itself
 * (capture lives in the main window) — `join` hands off to main.
 */
export interface LoquiNotificationsApi {
  /** Subscribe to "a meeting is imminent" pushes. Returns an unsubscribe fn. */
  onMeetingDetected(cb: (event: CalendarEvent) => void): () => void;
  /** "Join & Record" the imminent meeting by id (main opens the link + starts it). */
  join(eventId: string): Promise<void>;
  /** Dismiss the popup. */
  dismiss(): Promise<void>;
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
  /** Permanently delete a meeting (files + index). Destructive; refused while recording. */
  deleteMeeting(params: DeleteMeetingParams): Promise<void>;
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
  openScreenSettings: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.audioOpenScreenSettings),
  onSystemLevel: (
    cb: (payload: { meetingId: string; level: number }) => void,
  ): (() => void) => {
    const listener = (_e: unknown, payload: { meetingId: string; level: number }): void =>
      cb(payload);
    ipcRenderer.on(IPC.audioSystemLevel, listener);
    return () => ipcRenderer.removeListener(IPC.audioSystemLevel, listener);
  },
  setSystemMuted: (payload: { meetingId: string; muted: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC.audioSetSystemMuted, payload),
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
  deleteMeeting: (params: DeleteMeetingParams): Promise<void> =>
    ipcRenderer.invoke(IPC.deleteMeeting, params),
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

const notifications: LoquiNotificationsApi = {
  onMeetingDetected: (cb: (event: CalendarEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: CalendarEvent): void => cb(event);
    ipcRenderer.on(IPC.notificationMeetingDetected, listener);
    return () => ipcRenderer.removeListener(IPC.notificationMeetingDetected, listener);
  },
  join: (eventId: string): Promise<void> => ipcRenderer.invoke(IPC.notificationJoin, eventId),
  dismiss: (): Promise<void> => ipcRenderer.invoke(IPC.notificationDismiss),
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
  calendar,
  autoRecord,
  export: exportApi,
  updater,
  notifications,
  onStartRequest: (cb: (params: StartMeetingParams) => void): (() => void) => {
    const listener = (_e: unknown, params: StartMeetingParams): void => cb(params);
    ipcRenderer.on(IPC.meetingStartRequest, listener);
    return () => ipcRenderer.removeListener(IPC.meetingStartRequest, listener);
  },
};

contextBridge.exposeInMainWorld("loqui", api);
