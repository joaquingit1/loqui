/**
 * Main-process capture orchestration (PRD-1, unit "main-capture-orchestration").
 *
 * Reusable, headless-testable primitives for the Electron MAIN-process dual-
 * stream audio capture: the bounded frame queue + drop policy, the
 * audioStart/Stop sequencing state machine, the loopback display-media handler,
 * and macOS Screen-Recording permission handling. These own only the
 * orchestration concerns — they consume the Foundation-provided supervisor
 * surface and shared contract types; they never touch the supervisor/client
 * internals, the preload, the renderer, or the store.
 *
 * The Foundation wires these into `src/main/index.ts` (loopback registration,
 * permission status) and `src/main/audio/register.ts` (start/stop/frame IPC),
 * which delegate the lifecycle/backpressure logic to {@link CaptureOrchestrator}.
 */
export {
  DEFAULT_FRAME_QUEUE_CAPACITY,
  FrameQueue,
  type Frame,
  type FrameSink,
  type FrameQueueStats,
} from "./frame-queue.js";

export {
  CaptureOrchestrator,
  type AudioSupervisor,
  type CaptureOrchestratorOptions,
  type CaptureSourceStats,
} from "./orchestrator.js";

export {
  makeDisplayMediaLoopbackHandler,
  registerDisplayMediaLoopback,
  type DisplayMediaStreams,
  type LoopbackHandlerOptions,
  type LoopbackSession,
} from "./loopback.js";

export {
  SCREEN_SETTINGS_DEEP_LINK,
  resolveScreenPermission,
  isCaptureBlocked,
  needsPermissionUi,
  needsRestartAfterGrant,
  openScreenSettings,
  type RawMediaAccessStatus,
  type ScreenPermissionEnv,
  type OpenSettingsEnv,
  type OpenSettingsResult,
} from "./permission.js";
