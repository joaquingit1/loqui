/**
 * Electron main process entry. Creates the window with a hardened webPreferences
 * (contextIsolation: true, nodeIntegration: false, sandbox: true), wires the
 * IPC handlers to the sidecar supervisor + meeting store, and supervises the
 * sidecar lifecycle.
 *
 * STUB: the Build phase fills in window creation, IPC registration, and the
 * supervisor/store wiring. Imports below pin the contract.
 */
import { app, BrowserWindow, safeStorage, session, shell, systemPreferences } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Meeting, ScreenPermissionStatus } from "@loqui/shared";
import { SidecarSupervisor } from "./sidecar/supervisor.js";
import { openStore, type MeetingStore } from "./store/index.js";
import { IPC } from "../shared/ipc.js";
import {
  pushMeetingStatus,
  pushSidecarStatus,
  pushTranscriptSegments,
  registerIpcHandlers,
} from "./ipc/register.js";
import { registerAudioIpc } from "./audio/register.js";
import { ChatKeystore } from "./chat/keystore.js";
import { forwardChatStream, registerChatIpc } from "./chat/register.js";
import {
  HfKeystore,
  createPostProcessPipeline,
  forwardJobUpdates,
  registerPostProcessIpc,
} from "./postprocess/index.js";
import {
  consumeFinalTranscriptSegments,
  createMeetingController,
  createTranscriptWriter,
} from "./transcript/index.js";
import { createImportPipeline } from "./import/pipeline.js";
import { McpServerManager, makeMcpStatusPush, registerMcpIpc } from "./mcp/index.js";
import {
  CalendarKeystore,
  FakeCalendarProvider,
  GoogleProvider,
  MicrosoftProvider,
  ZoomProvider,
  createCalendarService,
  registerCalendarIpc,
  type CalendarHttp,
  type CalendarProviderRegistry,
  type CalendarServiceImpl,
} from "./calendar/index.js";
import type { OAuthHttp } from "./calendar/oauth.js";
// PRD-6 Google Meet speaker-name attribution. The loopback WS server
// (createExtensionWsServer) accepts the browser extension's {ts,name,speaking}
// events ONLY while a meeting is recording, the PURE correlation engine
// (correlateSpeakerNames) maps diarized `Speaker N` turns -> names after
// diarization, and the name-applier (applySpeakerNames — REUSES the PRD-5
// diarized-rewrite path) applies them; the IPC bridge (registerSpeakerNamesIpc)
// surfaces status to the renderer, and the post-diarization hook
// (subscribeSpeakerNamesCorrelation) drives correlate+apply on postProcessDone.
// Every path is best-effort: an absent/broken extension degrades to generic
// `Speaker N` labels with no crash. The Python sidecar is NOT involved.
import {
  createExtensionWsServer,
  activeMeetingFromController,
  correlateSpeakerNames,
  applySpeakerNames,
  registerSpeakerNamesIpc,
  subscribeSpeakerNamesCorrelation,
  type ExtensionWsServer,
} from "./speakernames/index.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");

// Hardened webPreferences applied to every window.
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    show: false,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // CommonJS preload (.cjs) — required because sandbox is enabled; see the
      // preload build output config in electron.vite.config.ts.
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  win.once("ready-to-show", () => win.show());
  loadRenderer(win);
  return win;
}

/**
 * Point the window at the renderer: the dev server (electron-vite sets
 * ELECTRON_RENDERER_URL) when present, else the built HTML on disk.
 */
function loadRenderer(win: BrowserWindow): void {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * Resolve the macOS Screen-Recording permission status used for system/loopback
 * audio capture. Non-macOS platforms need no such grant.
 */
export function getScreenPermissionStatus(): ScreenPermissionStatus {
  if (process.platform !== "darwin") return "not-applicable";
  // getMediaAccessStatus("screen") returns one of granted/denied/restricted/
  // not-determined/unknown — map the matching subset onto our contract.
  const status = systemPreferences.getMediaAccessStatus("screen");
  switch (status) {
    case "granted":
    case "denied":
    case "restricted":
    case "not-determined":
      return status;
    default:
      return "not-determined";
  }
}

/**
 * Register the loopback display-media handler so the renderer's
 * `getDisplayMedia({ audio: true })` yields system/loopback audio. On macOS
 * this routes through the Screen-Recording permission. Build units refine the
 * source selection; Foundation wires the `{ audio: "loopback" }` seam.
 */
function registerDisplayMediaLoopback(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Build unit "renderer-capture" selects the screen/window source for the
      // video track; Foundation guarantees the loopback audio path is enabled.
      callback({ audio: "loopback" });
    },
    { useSystemPicker: false },
  );
}

// Module-scoped singletons so quit handlers can tear them down.
let supervisor: SidecarSupervisor | null = null;
let store: MeetingStore | null = null;
let mainWindow: BrowserWindow | null = null;
let disposeIpc: (() => void) | null = null;
let disposeStatusPush: (() => void) | null = null;
let disposeTranscriptPush: (() => void) | null = null;
let disposeTranscriptPersist: (() => void) | null = null;
let disposeMeetingStatusPush: (() => void) | null = null;
let disposeAudioIpc: (() => void) | null = null;
let disposeChatIpc: (() => void) | null = null;
let disposeChatStreamPush: (() => void) | null = null;
let disposePostProcessIpc: (() => void) | null = null;
let disposeJobUpdatePush: (() => void) | null = null;
let disposePostProcessPipeline: (() => void) | null = null;
let disposeImportPipeline: (() => void) | null = null;
let mcpManager: McpServerManager | null = null;
let disposeMcpIpc: (() => void) | null = null;
// PRD-15 calendar seam: the disposer for the calendar IPC bridge + push, and
// the service (fan-out/normalize/dedup/poll) it's bound to.
let disposeCalendarIpc: (() => void) | null = null;
let calendarService: CalendarServiceImpl | null = null;
// PRD-6 speaker-names seam: the loopback extension WS server, its IPC bridge +
// status-push disposer, and the disposer that unhooks the post-diarization
// correlation pass. All null until the Build phase wires `wireSpeakerNames`.
let extensionWsServer: ExtensionWsServer | null = null;
let disposeSpeakerNamesIpc: (() => void) | null = null;
let disposeSpeakerNamesCorrelation: (() => void) | null = null;

/**
 * Create the window, open the store, start + supervise the sidecar, register
 * the IPC handlers, push sidecar status to the renderer, and wire clean
 * shutdown on app quit.
 */
export async function bootstrap(): Promise<void> {
  await app.whenReady();

  store = openStore();
  supervisor = new SidecarSupervisor();

  mainWindow = createWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Enable loopback system-audio capture for getDisplayMedia (PRD-1).
  registerDisplayMediaLoopback();

  // Push status changes to whatever window is live at emit time.
  disposeStatusPush = pushSidecarStatus(supervisor, () => mainWindow);
  // Forward sidecar transcriptSegment notifications to the renderer (PRD-2).
  disposeTranscriptPush = pushTranscriptSegments(supervisor, () => mainWindow);
  // Persist + index every confirmed (final) segment (PRD-3): the TranscriptWriter
  // appends to transcript.live.md and the store indexes the text into FTS. This
  // is the SOLE feeder of the (append-only) writer.
  const transcriptWriter = createTranscriptWriter();
  disposeTranscriptPersist = consumeFinalTranscriptSegments({
    supervisor,
    writer: transcriptWriter,
    store,
  });

  // Post-meeting diarization + AI summaries (PRD-5). The HF token (gated pyannote
  // weights) is stored encrypted via the OS keychain (safeStorage), reusing the
  // PRD-4 mechanism in a separate file. The pipeline waits for the existing
  // audioFinalized signal after stop, sends ONE `postProcess` WS request to the
  // sidecar (provider config + transient summary key + transient HF token,
  // injected out of band), relays jobUpdate progress to the renderer, and on
  // postProcessDone indexes the diarized+summary text + records speakers into
  // meta + transitions the meeting to "done". It NEVER writes the live transcript.
  const chatKeystore = new ChatKeystore(safeStorage);
  const hfKeystore = new HfKeystore(safeStorage);
  const pushMeetingStatusToRenderer = (meeting: Meeting): void => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.meetingStatus, { meeting });
    }
  };
  const postProcessPipeline = createPostProcessPipeline({
    supervisor,
    store,
    providerKeys: chatKeystore,
    hfKeystore,
    emitStatus: pushMeetingStatusToRenderer,
  });
  disposePostProcessPipeline = () => postProcessPipeline.dispose();
  disposeJobUpdatePush = forwardJobUpdates(supervisor, () => mainWindow);
  disposePostProcessIpc = registerPostProcessIpc({
    store,
    hfKeystore,
    pipeline: postProcessPipeline,
  });

  // The meeting lifecycle state machine (PRD-3): drives Meeting.status +
  // startedAt/endedAt via the store and sets/clears the supervisor's active-
  // meeting pointer so PRD-1 audio frames + PRD-2 final segments route to the
  // recording meeting. It NEVER writes transcript.live.md (that is exclusively
  // the TranscriptWriter wired above). The PRD-5 postProcess hook hands a stopped
  // meeting to the pipeline (recording -> processing; the pipeline owns the
  // eventual processing -> done after diarization + summary).
  const controller = createMeetingController({
    store,
    supervisor,
    postProcess: (meeting) => postProcessPipeline.onMeetingProcessing(meeting),
  });
  // Push lifecycle/status transitions to the renderer so the Library/live view
  // reacts without re-listing.
  disposeMeetingStatusPush = pushMeetingStatus(controller, () => mainWindow);

  // File import (PRD-12). REUSES the same store + provider/HF key sources + the
  // jobUpdate relay as the PRD-5 pipeline; it only mints the kind:"import"
  // meeting, sends ONE `importFile` WS request to the sidecar (which decodes +
  // transcribes + diarizes + summarizes the file via the EXISTING pipeline), and
  // finalizes the meeting on `importFileDone`. It NEVER writes the transcript.
  const importPipeline = createImportPipeline({
    supervisor,
    store,
    providerKeys: chatKeystore,
    hfKeystore,
    emitStatus: pushMeetingStatusToRenderer,
  });
  disposeImportPipeline = () => importPipeline.dispose();

  disposeIpc = registerIpcHandlers({
    supervisor,
    store,
    controller,
    importPipeline,
    getWindow: () => mainWindow,
  });
  disposeAudioIpc = registerAudioIpc({
    supervisor,
    getScreenPermission: getScreenPermissionStatus,
  });

  // In-call AI chat + provider abstraction (PRD-4). The keystore stores the BYOK
  // key encrypted via the OS keychain (safeStorage) and the non-secret provider
  // settings as JSON. registerChatIpc forwards `chat:send` to the sidecar as a
  // `chatRequest` WS notification (injecting the transient key out of band);
  // forwardChatStream relays the sidecar's streamed chatToken/chatDone/chatError
  // notifications to the renderer. The AI never edits the transcript — this
  // bridge has no transcript write path; the sidecar reads it READ-ONLY. The
  // keystore (`chatKeystore`) is created above and shared with the PRD-5 summary
  // step (which reuses the same provider config + BYOK key).
  disposeChatIpc = registerChatIpc({ supervisor, keystore: chatKeystore });
  disposeChatStreamPush = forwardChatStream(supervisor, () => mainWindow);

  // Local read-only MCP server (PRD-7). The app can optionally spawn/stop the
  // bundled `loqui-mcp` server (over loopback HTTP) bound to the resolved data
  // root, and prints ready-to-paste agent config snippets. It is AVAILABLE to
  // run but NOT forced on — the app does not auto-start it; Settings does. The
  // server is STRICTLY READ-ONLY over the meeting store (no write/edit/delete
  // tool, SQLite opened readonly); this manager only starts/stops it + reports
  // status. Status changes are pushed to the renderer for the Settings indicator.
  mcpManager = new McpServerManager({
    onStatusChange: makeMcpStatusPush(() => mainWindow),
  });
  disposeMcpIpc = registerMcpIpc({ manager: mcpManager });

  // Calendar integration + Home/Today view (PRD-15). FOUNDATION SEAM — Build
  // unit A implements `createCalendarService` (the service that fans out over
  // connected accounts via injectable CalendarProviders, normalizes + merges +
  // de-dups events, caches w/ short TTL + manual refresh, and emits a
  // `calendar:updated` push) backed by a safeStorage-keystore CalendarTokenStore
  // (REUSING the PRD-4/5 keychain mechanism — `safeStorage` is already in scope
  // above). registerCalendarIpc (already wired below once the factory exists)
  // binds the window.loqui.calendar channels to it. Strictly READ-ONLY over the
  // provider calendar; never writes a transcript; OAuth runs a loopback-PKCE
  // flow whose one-shot redirect listener binds 127.0.0.1 only.
  //
  // Production HTTP is a thin wrapper over the global `fetch` (the only place
  // the calendar feature touches the network — and only inside a connected
  // provider's OAuth/list calls). The consent page opens via shell.openExternal.
  const calendarHttp: CalendarHttp = (url, init) => fetch(url, init);
  const calendarOAuthHttp: OAuthHttp = (url, init) => fetch(url, init);
  const openExternal = (url: string): Promise<void> => shell.openExternal(url);
  const realProviderDeps = { http: calendarHttp, oauthHttp: calendarOAuthHttp, openExternal };
  const calendarProviders: CalendarProviderRegistry = {
    google: new GoogleProvider(realProviderDeps),
    microsoft: new MicrosoftProvider(realProviderDeps),
    zoom: new ZoomProvider(realProviderDeps),
  };
  // A hermetic FakeCalendarProvider is swapped in when LOQUI_CALENDAR_FAKE=1
  // (the smoke + manual local runs) so connect/list never touch the network.
  if (process.env["LOQUI_CALENDAR_FAKE"] === "1") {
    calendarProviders.google = new FakeCalendarProvider({ source: "google" });
    calendarProviders.microsoft = new FakeCalendarProvider({ source: "microsoft" });
    calendarProviders.zoom = new FakeCalendarProvider({ source: "zoom" });
  }
  calendarService = createCalendarService({
    tokenStore: new CalendarKeystore(safeStorage),
    providers: calendarProviders,
  });
  disposeCalendarIpc = registerCalendarIpc({
    service: calendarService,
    getWindow: () => mainWindow,
  });

  // Google Meet speaker-name attribution (PRD-6). GRACEFUL DEGRADATION is the #1
  // invariant: every step below is best-effort, so a bind failure, an absent
  // extension, or a correlation error is logged + swallowed and the meeting still
  // completes with generic `Speaker N` labels.
  //
  //   1. construct the loopback-ONLY extension WS server. `activeMeeting` adapts
  //      the PRD-3 `controller` so the server buffers {ts,name,speaking} events
  //      ONLY while a meeting is recording and IGNORES them otherwise. start()
  //      binds 127.0.0.1 only; a bind failure (e.g. port busy) leaves the server
  //      inert (status stays `disconnected`) and must not block bootstrap.
  //   2. register the status IPC + status push so the renderer indicator reflects
  //      connect/capture state (and clearly says diarization works without it).
  //   3. hook the post-diarization correlation pass: after `postProcessDone` for
  //      a Google-Meet meeting, drain that meeting's buffered activity, run the
  //      PURE `correlateSpeakerNames` over the freshly-written diarized
  //      transcript, and apply via `applySpeakerNames` (REUSES the PRD-5
  //      diarized-rewrite path; MANUAL renames win; the live transcript stays
  //      byte-identical). Subscribes the SAME supervisor notification fan-out the
  //      PRD-5 pipeline uses, filtered to postProcessDone.
  extensionWsServer = createExtensionWsServer({
    activeMeeting: activeMeetingFromController(controller),
  });
  // Bind in the background; a bind failure degrades silently (no listener =>
  // the extension never connects => generic labels), never blocking the window.
  void extensionWsServer.start().catch((err: unknown) => {
    console.error("[loqui] speakernames WS server failed to start:", err);
  });
  disposeSpeakerNamesIpc = registerSpeakerNamesIpc({
    server: extensionWsServer,
    getWindow: () => mainWindow,
  });
  disposeSpeakerNamesCorrelation = subscribeSpeakerNamesCorrelation({
    supervisor,
    hook: {
      server: extensionWsServer,
      store,
      correlate: correlateSpeakerNames,
      apply: applySpeakerNames,
    },
    getMeeting: (id) => store?.getMeeting(id) ?? null,
  });

  // Start the sidecar in the background; failure surfaces via status push and
  // must not block window creation.
  void supervisor.start().catch((err: unknown) => {
    console.error("[loqui] sidecar failed to start:", err);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      mainWindow.on("closed", () => {
        mainWindow = null;
      });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Graceful teardown: stop the sidecar (WS shutdown -> SIGTERM -> SIGKILL)
  // and close the store before the process exits.
  let shuttingDown = false;
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });
}

/** Tear down IPC, the supervisor, and the store. Idempotent. */
async function shutdown(): Promise<void> {
  disposeIpc?.();
  disposeIpc = null;
  disposeAudioIpc?.();
  disposeAudioIpc = null;
  disposeChatIpc?.();
  disposeChatIpc = null;
  disposeChatStreamPush?.();
  disposeChatStreamPush = null;
  disposePostProcessIpc?.();
  disposePostProcessIpc = null;
  disposeJobUpdatePush?.();
  disposeJobUpdatePush = null;
  disposePostProcessPipeline?.();
  disposePostProcessPipeline = null;
  disposeImportPipeline?.();
  disposeImportPipeline = null;
  disposeMcpIpc?.();
  disposeMcpIpc = null;
  mcpManager?.dispose();
  mcpManager = null;
  // PRD-15 calendar teardown (disposes the IPC bridge + push + service polling
  // once Build unit A wires it above).
  disposeCalendarIpc?.();
  disposeCalendarIpc = null;
  calendarService?.dispose();
  calendarService = null;
  // PRD-6 speaker-names teardown (unhooks the correlation pass + IPC/status push
  // and stops the loopback extension WS server once the Build phase wires them).
  disposeSpeakerNamesCorrelation?.();
  disposeSpeakerNamesCorrelation = null;
  disposeSpeakerNamesIpc?.();
  disposeSpeakerNamesIpc = null;
  try {
    await extensionWsServer?.stop();
  } catch (err) {
    console.error("[loqui] error stopping extension WS server:", err);
  }
  extensionWsServer = null;
  disposeStatusPush?.();
  disposeStatusPush = null;
  disposeTranscriptPush?.();
  disposeTranscriptPush = null;
  disposeTranscriptPersist?.();
  disposeTranscriptPersist = null;
  disposeMeetingStatusPush?.();
  disposeMeetingStatusPush = null;
  try {
    await supervisor?.stop();
  } catch (err) {
    console.error("[loqui] error stopping sidecar:", err);
  }
  supervisor = null;
  try {
    store?.close();
  } catch (err) {
    console.error("[loqui] error closing store:", err);
  }
  store = null;
}

// Auto-bootstrap when run as the Electron main entry (not when imported by a
// test). Electron sets process.versions.electron; vitest (plain node) does not.
if (process.versions.electron) {
  void bootstrap().catch((err: unknown) => {
    console.error("[loqui] bootstrap failed:", err);
    app.quit();
  });
}
