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
  ChatProvider,
  ChatSendParams,
  ChatStreamEvent,
  DiarizedTranscript,
  GetDiarizedTranscriptParams,
  GetSummaryParams,
  GetTranscriptParams,
  Health,
  HfTokenStatus,
  JobEvent,
  ListMeetingsQuery,
  McpConfigSnippet,
  McpStatus,
  LoquiAudioApi,
  Meeting,
  MeetingSearchHit,
  MeetingStatusEvent,
  ProviderConfig,
  RegenerateSummaryParams,
  RenameMeetingParams,
  RenameSpeakerParams,
  ScreenPermissionStatus,
  SetApiKeyParams,
  SetHfTokenParams,
  StartMeetingParams,
  StopMeetingParams,
  Summary,
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
  /** In-call AI chat + provider abstraction bridge (PRD-4). */
  chat: LoquiChatApi;
  /** Post-meeting diarization + AI summaries bridge (PRD-5). */
  postprocess: LoquiPostProcessApi;
  /** Local read-only MCP server lifecycle + config bridge (PRD-7). */
  mcp: LoquiMcpApi;
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
};

contextBridge.exposeInMainWorld("loqui", api);
