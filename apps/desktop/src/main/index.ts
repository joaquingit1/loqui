/**
 * Electron main process entry. Creates the window with a hardened webPreferences
 * (contextIsolation: true, nodeIntegration: false, sandbox: true), wires the
 * IPC handlers to the sidecar supervisor + meeting store, and supervises the
 * sidecar lifecycle.
 *
 * STUB: the Build phase fills in window creation, IPC registration, and the
 * supervisor/store wiring. Imports below pin the contract.
 */
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { join } from "node:path";
import { release as osRelease } from "node:os";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import {
  AUDIO_WAV_FILENAME,
  transcriptionSettingsToEnv,
  type Meeting,
  type ScreenPermissionStatus,
  type UpdateAutoRecordSettings,
} from "@loqui/shared";
import { SidecarSupervisor } from "./sidecar/supervisor.js";
import { openStore, meetingAudioDir, type MeetingStore } from "./store/index.js";
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
import { ExportService } from "./export/index.js";
import { registerExportIpc } from "./export/register.js";
import { registerTranscriptionIpc } from "./transcription/register.js";
import { SettingsStore } from "./settings/store.js";
import { defaultCaptureCapabilityProbe } from "./capture/perapp.js";
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
// PRD-11 auto-record on meeting detection + menubar/tray. The PURE decision core
// (decide) is wrapped by the engine, which polls the injectable native probe +
// the browser in-call source (PRD-6 WS — no new socket) and applies start/stop
// via the SAME PRD-3 lifecycle controller. The tray (Electron Tray/Menu) gives
// quick controls + a recording-state icon + launch-at-login. Auto-record is OFF
// by default (manual-only PRD-3) until the user opts in.
import {
  createAutoRecordEngine,
  createNativeMeetingProbe,
  browserCallSourceFromWsServer,
  registerAutoRecordIpc,
  createTray,
  createTrayElectron,
  type AutoRecordEngine,
  type TrayController,
} from "./autorecord/index.js";
// PRD-8 packaging + custom GitHub auto-updater. The AppPaths resolver translates
// dev vs packaged layout (bundled sidecar/MCP binaries, the OS helper scripts,
// the install/relaunch/staging paths). The UpdaterManager checks the public
// GitHub `version.json` on launch + on an interval, semver-compares, and (when
// newer) downloads + sha256-VERIFIES + stages the new bundle via Node https
// (NOT a browser — the no-quarantine detail), then on an explicit restart spawns
// a DETACHED OS helper that swaps the bundle + relaunches. Integrity (invariant
// #2): only public release assets, verified before any swap — no Loqui server;
// a mismatch / offline / partial download fails safely with the app intact.
import {
  AppPaths,
  UpdaterManager,
  makeGithubManifestFetcher,
  makeUpdaterStatePush,
  registerUpdaterIpc,
} from "./updater/index.js";

const __dirname = join(fileURLToPath(import.meta.url), "..");

// Hardened webPreferences applied to every window.
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

export function createWindow(opts?: { contentProtection?: boolean }): BrowserWindow {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  // PRD-16 macOS-native vibrancy/glass: on macOS the window requests
  // "under-window" vibrancy with a transparent body so the renderer's frosted
  // panels float over real desktop blur (matching the reference aesthetic). On
  // Windows 11 we request the "mica" backdrop material; everywhere else the
  // window stays opaque and the renderer's CSS glass recipe is the fallback.
  // Guarded so it never breaks Windows/Linux: unsupported options are simply
  // omitted (transparent stays false off-macOS so window controls render).
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    show: false,
    // Warm paper backstop behind the renderer (and the colour Electron uses
    // before first paint); on macOS the transparent window lets vibrancy show.
    backgroundColor: isMac ? "#00000000" : "#FBF8F3",
    ...(isMac
      ? { vibrancy: "under-window" as const, visualEffectState: "active" as const, transparent: true }
      : {}),
    ...(isWin ? { backgroundMaterial: "mica" as const } : {}),
    titleBarStyle: isMac ? ("hiddenInset" as const) : undefined,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // CommonJS preload (.cjs) — required because sandbox is enabled; see the
      // preload build output config in electron.vite.config.ts.
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  // PRD-13: hide the window from screen capture/recording when enabled (ON by
  // default). Cross-platform in Electron (macOS NSWindow sharingType; Windows
  // SetWindowDisplayAffinity). Applied at creation; the privacy toggle re-applies
  // it live via setContentProtection.
  win.setContentProtection(opts?.contentProtection ?? true);
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
 * Remove a meeting's per-source WAVs (mic.wav/system.wav) — the
 * `delete-after-processing` audio-retention cleanup (PRD-13). Best-effort:
 * `force: true` makes a missing file a no-op so it never throws.
 */
function deleteMeetingAudioFiles(meetingId: string): void {
  const dir = meetingAudioDir(meetingId);
  for (const file of Object.values(AUDIO_WAV_FILENAME)) {
    rmSync(join(dir, file), { force: true });
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
// PRD-13 export + capture/privacy seam: the disposer for the export/privacy IPC
// bridge and the settings store it (plus the audio + postprocess paths) read.
let disposeExportIpc: (() => void) | null = null;
// PRD-9 pluggable-transcription-engine IPC bridge disposer.
let disposeTranscriptionIpc: (() => void) | null = null;
let settingsStore: SettingsStore | null = null;
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
// PRD-11 auto-record seam: the detection engine, its IPC bridge disposer, the
// tray controller, and the engine's state-push -> tray subscription disposer.
let autoRecordEngine: AutoRecordEngine | null = null;
let disposeAutoRecordIpc: (() => void) | null = null;
let tray: TrayController | null = null;
let disposeTraySync: (() => void) | null = null;
// PRD-8 updater seam: the manager (periodic check + download/verify/stage) and
// the disposer for its IPC bridge. The manager is started after the window so
// the first-launch check can push state to a live renderer.
let updaterManager: UpdaterManager | null = null;
let disposeUpdaterIpc: (() => void) | null = null;

function applyRunInBackground(enabled: boolean): void {
  if (enabled) app.dock?.hide();
  else app.dock?.show();
}

/**
 * Create the window, open the store, start + supervise the sidecar, register
 * the IPC handlers, push sidecar status to the renderer, and wire clean
 * shutdown on app quit.
 */
export async function bootstrap(): Promise<void> {
  await app.whenReady();

  // PRD-8: resolve dev-vs-packaged paths once (bundled sidecar/MCP binaries, the
  // OS helper scripts, install/relaunch/staging). In dev `isPackaged` is false so
  // the bundled-bin resolvers return null and the supervisor/MCP fall back to the
  // uv/source path; in a packaged app they resolve `process.resourcesPath/...`.
  const appPaths = new AppPaths(app, {
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
  });

  store = openStore();

  // PRD-13 capture/privacy + export settings (non-secret JSON). Read BEFORE the
  // window is created so the content-protection toggle (ON by default) is applied
  // at creation. Shared with the audio retention path + the export service.
  // Created before the supervisor so the PRD-9 transcription-engine env can be
  // read from it on each (re)spawn.
  settingsStore = new SettingsStore();

  // Packaged: run the bundled sidecar binary directly (no uv/Python on the host).
  // PRD-9: hand the sidecar the selected transcription engine via the
  // LOQUI_TRANSCRIPTION_* env contract, read FRESH on each spawn so a settings
  // change takes effect for the next sidecar launch (= the next meeting).
  supervisor = new SidecarSupervisor({
    bundledBinPath: appPaths.bundledSidecarBin(),
    extraEnv: () => transcriptionSettingsToEnv(settingsStore!.getTranscriptionSettings()),
  });

  applyRunInBackground(settingsStore.getAutoRecordSettings().runInBackground);

  mainWindow = createWindow({
    contentProtection: settingsStore.getCaptureSettings().contentProtection,
  });
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
    // PRD-13 audio-retention: after diarization consumes the WAVs, the
    // `delete-after-processing` policy removes mic.wav/system.wav.
    getAudioRetention: () => settingsStore!.getCaptureSettings().audioRetention,
    deleteAudioFiles: deleteMeetingAudioFiles,
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
    // PRD-13 audio-retention: `never-save` => the orchestrator tells the sidecar
    // not to persist the WAVs (stream-only).
    getAudioRetention: () => settingsStore!.getCaptureSettings().audioRetention,
  });

  // Export & interop + capture/privacy controls (PRD-13). The ExportService is
  // READ-ONLY over the canonical transcript (it builds a model from the diarized
  // transcript — else the live transcript — + summary and writes a NEW file).
  // The privacy bridge persists the non-secret capture settings and re-applies
  // the content-protection toggle to the live window(s) live; the per-app
  // capability probe degrades to full loopback until the native macOS/Windows
  // process-tap path is verified (see ./capture/perapp.ts).
  const exportService = new ExportService({
    store,
    getExportDir: () => settingsStore!.getExportDir(),
  });
  disposeExportIpc = registerExportIpc({
    exportService,
    settings: settingsStore,
    captureProbe: defaultCaptureCapabilityProbe(process.platform, osRelease()),
    applyContentProtection: (enabled: boolean) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) win.setContentProtection(enabled);
    },
    getWindow: () => mainWindow,
  });

  // PRD-9 pluggable transcription engines: read/patch the engine/model/language
  // settings + list the selectable engines for the Settings UI. The chosen engine
  // is handed to the sidecar via the supervisor's extraEnv on the next spawn.
  disposeTranscriptionIpc = registerTranscriptionIpc({ settings: settingsStore });

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
    // Packaged: spawn the bundled native `loqui-mcp` binary; dev => undefined so
    // the lifecycle resolves the built JS bin / PATH (PRD-8 packaging).
    binPath: appPaths.bundledMcpBin() ?? undefined,
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

  // Auto-record on meeting detection + menubar/tray (PRD-11). MANUAL-FIRST: the
  // engine reads the persisted policy (OFF by default) and only watches when the
  // user opts in. It REUSES the PRD-3 `controller` for start/stop, the OS native
  // probe for conferencing apps + mic, and the PRD-6 WS server's browser in-call
  // signal (no new socket). The tray gives quick controls + a recording-state
  // icon + launch-at-login; the main window stays available.
  const openMainWindow = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    mainWindow = createWindow({
      contentProtection: settingsStore?.getCaptureSettings().contentProtection ?? true,
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  };

  autoRecordEngine = createAutoRecordEngine({
    settings: settingsStore.getAutoRecordSettings(),
    lifecycle: controller,
    nativeProbe: createNativeMeetingProbe(process.platform),
    browserSource: browserCallSourceFromWsServer(extensionWsServer),
  });
  disposeAutoRecordIpc = registerAutoRecordIpc({
    engine: autoRecordEngine,
    settings: settingsStore,
    setLoginItemSettings: (enabled: boolean) =>
      app.setLoginItemSettings({ openAtLogin: enabled }),
    applyRunInBackground,
    getWindow: () => mainWindow,
  });

  // The tray view: rebuilt from the engine state + recent meetings on every
  // engine state change (and once now). Recent meetings come straight from the
  // store (newest-first, capped). Start/stop go through the SAME controller the
  // manual IPC path uses; openMeeting surfaces + focuses the window.
  const trayElectron = createTrayElectron({ Tray, Menu, nativeImage, app });
  const recentMeetings = (): { id: string; title: string }[] => {
    try {
      return (store?.listMeetings({ limit: 5 }) ?? []).map((m) => ({
        id: m.id,
        title: m.title,
      }));
    } catch {
      return [];
    }
  };
  const trayModel = () => ({
    state: autoRecordEngine!.getState(),
    autoRecord: {
      enabled: settingsStore!.getAutoRecordSettings().enabled,
      onDetect: settingsStore!.getAutoRecordSettings().onDetect,
    },
    recentMeetings: recentMeetings(),
    launchAtLogin: settingsStore!.getAutoRecordSettings().launchAtLogin,
  });
  const updateAutoRecordSettings = (patch: UpdateAutoRecordSettings): void => {
    const merged = settingsStore!.setAutoRecordSettings(patch);
    autoRecordEngine?.applySettings(merged);
    applyRunInBackground(merged.runInBackground);
    tray?.update(trayModel());
  };
  // Building the Tray requires the OS tray to be available; guard so a headless
  // failure never blocks bootstrap (the app still works windowed).
  try {
    tray = createTray(
      trayElectron,
      {
        startMeeting: () => void controller.startMeeting(),
        stopMeeting: () => {
          const active = controller.getActiveMeeting();
          if (active) void controller.stopMeeting({ id: active.id });
        },
        acceptPendingStart: () => void autoRecordEngine?.acceptPendingStart(),
        setAutoRecordEnabled: (enabled: boolean) =>
          updateAutoRecordSettings({ enabled }),
        setAutoRecordOnDetect: (onDetect) =>
          updateAutoRecordSettings({ onDetect }),
        openWindow: openMainWindow,
        openMeeting: () => openMainWindow(),
        setLaunchAtLogin: (enabled: boolean) => {
          updateAutoRecordSettings({ launchAtLogin: enabled });
          try {
            app.setLoginItemSettings({ openAtLogin: enabled });
          } catch (err) {
            console.error("[loqui] auto-record: setLoginItemSettings failed:", err);
          }
        },
        quit: () => app.quit(),
      },
      trayModel(),
    );
    disposeTraySync = autoRecordEngine.onStateChange(() => tray?.update(trayModel()));
  } catch (err) {
    console.error("[loqui] tray unavailable (continuing windowed):", err);
  }

  // Reflect the persisted launch-at-login to the OS at boot, then start watching
  // (a no-op when auto-record is disabled).
  try {
    app.setLoginItemSettings({
      openAtLogin: settingsStore.getAutoRecordSettings().launchAtLogin,
    });
  } catch (err) {
    console.error("[loqui] auto-record: setLoginItemSettings failed:", err);
  }
  autoRecordEngine.start();

  // PRD-8 custom GitHub auto-updater. Fetches the latest release's public
  // `version.json`, semver-compares against the running version, and (when newer
  // + auto-download on) downloads + sha256-VERIFIES + stages the new bundle via
  // Node https. quitAndInstall spawns the DETACHED OS helper (swap + relaunch)
  // and quits. Auto-check is ON by default (configurable interval ~30 min). Every
  // path is best-effort + SAFE: offline / rate-limit / partial download / sha256
  // mismatch leave the installed app untouched and surface on the state. The
  // staged update is only applied on an explicit restart.
  updaterManager = new UpdaterManager({
    settings: settingsStore!,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    fetchManifest: makeGithubManifestFetcher(),
    stagingDir: appPaths.stagingDir(),
    helperInput: () => ({
      platform: process.platform,
      helperScript: appPaths.helperScript(),
      parentPid: process.pid,
      installPath: appPaths.installPath(),
      relaunchTarget: appPaths.relaunchTarget(),
    }),
    quit: () => app.quit(),
    onStateChange: makeUpdaterStatePush(() => mainWindow),
  });
  disposeUpdaterIpc = registerUpdaterIpc({
    manager: updaterManager,
    getWindow: () => mainWindow,
  });
  // Start the check loop (initial launch check + interval). Never blocks boot.
  try {
    updaterManager.start();
  } catch (err) {
    console.error("[loqui] updater failed to start:", err);
  }

  // Start the sidecar in the background; failure surfaces via status push and
  // must not block window creation.
  void supervisor.start().catch((err: unknown) => {
    console.error("[loqui] sidecar failed to start:", err);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow({
        contentProtection: settingsStore?.getCaptureSettings().contentProtection ?? true,
      });
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
  // PRD-13 export/privacy teardown.
  disposeExportIpc?.();
  disposeExportIpc = null;
  // PRD-9 transcription-engine IPC teardown.
  disposeTranscriptionIpc?.();
  disposeTranscriptionIpc = null;
  settingsStore = null;
  // PRD-15 calendar teardown (disposes the IPC bridge + push + service polling
  // once Build unit A wires it above).
  disposeCalendarIpc?.();
  disposeCalendarIpc = null;
  calendarService?.dispose();
  calendarService = null;
  // PRD-11 auto-record teardown: dispose the IPC bridge, the tray, the engine
  // state -> tray subscription, and the engine itself (stops the poll loop +
  // releases the lifecycle subscription). Stopping the engine does NOT stop an
  // in-progress recording — the lifecycle/sidecar teardown below handles that.
  disposeAutoRecordIpc?.();
  disposeAutoRecordIpc = null;
  disposeTraySync?.();
  disposeTraySync = null;
  tray?.destroy();
  tray = null;
  autoRecordEngine?.dispose();
  autoRecordEngine = null;
  // PRD-8 updater teardown: dispose the IPC bridge + stop the check timer. A
  // pending download is abandoned (it only ever wrote to the staging dir; the
  // installed app is untouched).
  disposeUpdaterIpc?.();
  disposeUpdaterIpc = null;
  updaterManager?.dispose();
  updaterManager = null;
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
