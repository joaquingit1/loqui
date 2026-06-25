/**
 * PRD-11 — the auto-record engine: the IMPURE orchestrator around the pure core.
 *
 * The engine owns the side effects the {@link decide} core must not: it polls the
 * injectable native probe + the browser in-call source on an interval, resolves
 * the boolean {@link DetectionInputs}, runs the pure decision core, and applies
 * the verdict via the PRD-3 meeting lifecycle (the SAME `startMeeting`/`stopMeeting`
 * the manual IPC path uses — NO new lifecycle). It tracks whether the active
 * recording was auto- or manually-started (so it never auto-stops a manual one),
 * surfaces an {@link AutoRecordState} to the renderer + tray, and handles the
 * `ask` prompt (it emits a `detected` phase and waits for `acceptPendingStart()`).
 *
 * ## Disable-able / manual-first
 * When settings `enabled` is false the engine is INERT: `start()` registers
 * nothing, no poll runs, no decisions fire. Manual start/stop flows through the
 * controller untouched — exactly PRD-3. Toggling `enabled` on/off via
 * `applySettings` starts/stops the poll loop live.
 *
 * ## Clock + timers
 * All timers (auto-stop grace, silence stop) live in the pure core, driven by the
 * injected `now()` — the engine just feeds `now()` each tick. The poll INTERVAL
 * itself uses an injectable `setIntervalFn`/`clearIntervalFn` (defaulting to the
 * globals) so tests drive ticks deterministically with fake timers.
 */
import {
  autoRecordSettingsSchema,
  autoRecordStateSchema,
  type AutoRecordSettings,
  type AutoRecordState,
  type DetectionInputs,
  type DetectionSource,
  type Meeting,
} from "@loqui/shared";
import {
  decide,
  initialDecisionState,
  type DecisionState,
} from "./decision.js";
import type { NativeMeetingProbe } from "./detectors.js";
import type { BrowserCallSource } from "./browser-source.js";

/** Default poll interval (ms). The OS probe is debounced to this cadence. */
export const AUTO_RECORD_DEFAULT_POLL_MS = 3000;

/**
 * The narrow lifecycle slice the engine drives — structurally a slice of the
 * PRD-3 {@link import("../transcript/controller.js").MeetingController}. The
 * engine REUSES it; it does not reimplement start/stop.
 */
export interface AutoRecordLifecycle {
  startMeeting(params?: { platform?: Meeting["platform"] }): Promise<Meeting>;
  stopMeeting(params: { id: string }): Promise<Meeting>;
  getActiveMeeting(): Meeting | null;
  onMeetingStatus(cb: (meeting: Meeting) => void): () => void;
}

export interface AutoRecordEngineDeps {
  /** Initial persisted settings (the master switch + policy). */
  settings: AutoRecordSettings;
  /** The PRD-3 lifecycle controller (reused for start/stop). */
  lifecycle: AutoRecordLifecycle;
  /** Best-effort native conferencing-app probe (injectable / mockable). */
  nativeProbe: NativeMeetingProbe;
  /** Browser in-call source (PRD-6 WS, no new socket). */
  browserSource: BrowserCallSource;
  /** Wall clock (epoch ms). Defaults to Date.now; tests inject a controllable one. */
  now?: () => number;
  /** Poll interval (ms). Defaults to {@link AUTO_RECORD_DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Injectable interval scheduler (tests pass fake-timer-aware fns). */
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface AutoRecordEngine {
  /** Begin watching (no-op when disabled). Idempotent. */
  start(): void;
  /** Stop watching + clear the poll loop. Does NOT stop an active recording. Idempotent. */
  stop(): void;
  /** The current runtime state (for the status invoke + tray). */
  getState(): AutoRecordState;
  /** Subscribe to state changes (push to renderer + tray). Returns unsubscribe. */
  onStateChange(cb: (state: AutoRecordState) => void): () => void;
  /** Re-apply settings live (e.g. user toggled enabled / changed timers). */
  applySettings(settings: AutoRecordSettings): void;
  /**
   * Accept a pending `ask`-policy prompt: start the detected meeting now (no-op
   * when nothing is pending). Wired to a renderer "Start" action.
   */
  acceptPendingStart(): Promise<void>;
  /** Dismiss a pending `ask` prompt without starting (no-op when none pending). */
  dismissPendingStart(): void;
  /** Run one detection tick immediately (used by tests + on-demand refresh). */
  tick(): Promise<void>;
  /** Stop watching + release the lifecycle subscription (final teardown). */
  dispose(): void;
}

/** The "nothing detected, disabled" baseline state. */
function disabledState(): AutoRecordState {
  return autoRecordStateSchema.parse({ enabled: false, phase: "disabled" });
}

export function createAutoRecordEngine(deps: AutoRecordEngineDeps): AutoRecordEngine {
  let settings = autoRecordSettingsSchema.parse(deps.settings);
  const { lifecycle, nativeProbe, browserSource } = deps;
  const now = deps.now ?? (() => Date.now());
  const pollMs = deps.pollMs ?? AUTO_RECORD_DEFAULT_POLL_MS;
  const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h));

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let core: DecisionState = initialDecisionState();
  const listeners = new Set<(state: AutoRecordState) => void>();

  // Whether the CURRENT active recording was auto-started by this engine (vs a
  // manual start). Tracked across ticks so the core never auto-stops a manual one.
  let autoStarted = false;
  // True while a start/stop call is in flight (prevents overlapping lifecycle ops).
  let busy = false;
  // The detection source + last-resolved probe booleans, for the surfaced state.
  let lastSource: DetectionSource = "none";
  let lastNativeApp = false;
  let lastMic = false;
  let lastBrowser = false;
  let silenceCountdownSec: number | null = null;
  // Whether a prompt-start is currently surfaced (phase `detected`) and its source.
  let pendingSource: DetectionSource | null = null;

  // If a meeting is stopped/finalized by ANY path (manual stop, post-processing),
  // clear our auto-started flag so a later manual start isn't mistaken for auto.
  const unsubLifecycle = lifecycle.onMeetingStatus((m: Meeting) => {
    if (m.status !== "recording") {
      // Only clear if this was the meeting we were tracking as active.
      if (lifecycle.getActiveMeeting() === null) {
        autoStarted = false;
        core = initialDecisionState();
        silenceCountdownSec = null;
        pendingSource = null;
      }
    }
  });

  function computeState(): AutoRecordState {
    const recording = lifecycle.getActiveMeeting() !== null;
    let phase: AutoRecordState["phase"];
    if (!settings.enabled) phase = "disabled";
    else if (recording && silenceCountdownSec !== null) phase = "countdown";
    else if (recording) phase = "recording";
    else if (pendingSource !== null) phase = "detected";
    else phase = "idle";
    return autoRecordStateSchema.parse({
      enabled: settings.enabled,
      phase,
      recording,
      autoStarted: recording ? autoStarted : false,
      source: recording ? lastSource : (pendingSource ?? "none"),
      nativeAppActive: lastNativeApp,
      micActive: lastMic,
      browserInCall: lastBrowser,
      silenceCountdownSec,
    });
  }

  function emit(): void {
    const state = computeState();
    for (const cb of listeners) {
      try {
        cb(state);
      } catch {
        /* a listener throwing must not break the engine */
      }
    }
  }

  /** Resolve the instantaneous detection inputs from the probes + clock. */
  async function resolveInputs(): Promise<DetectionInputs> {
    const recording = lifecycle.getActiveMeeting() !== null;

    let nativeAppActive = false;
    let micActive = false;
    if (settings.detectNativeApps) {
      try {
        const sample = await nativeProbe.sample(settings.appAllowlist);
        nativeAppActive = sample.appActive;
        micActive = sample.micActive;
      } catch {
        // TOTAL: a probe failure is "no native signal", never a crash.
      }
    }

    let browserInCall = false;
    if (settings.detectBrowserMeetings) {
      try {
        browserInCall = browserSource.getBrowserCallState().inCall;
      } catch {
        browserInCall = false;
      }
    }

    lastNativeApp = nativeAppActive;
    lastMic = micActive;
    lastBrowser = browserInCall;

    return {
      nativeAppActive,
      micActive,
      browserInCall,
      recording,
      autoStarted,
      now: now(),
    };
  }

  async function applyStart(source: DetectionSource): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const platform: Meeting["platform"] = source === "browser" ? "google-meet" : null;
      await lifecycle.startMeeting({ platform });
      autoStarted = true;
      lastSource = source;
      pendingSource = null;
    } catch (err) {
      // A failed auto-start must never crash the engine or block manual control.
      console.error("[loqui] auto-record: start failed:", err);
    } finally {
      busy = false;
    }
  }

  async function applyStop(): Promise<void> {
    if (busy) return;
    const active = lifecycle.getActiveMeeting();
    if (!active) return;
    busy = true;
    try {
      await lifecycle.stopMeeting({ id: active.id });
      autoStarted = false;
      core = initialDecisionState();
      silenceCountdownSec = null;
    } catch (err) {
      console.error("[loqui] auto-record: stop failed:", err);
    } finally {
      busy = false;
    }
  }

  async function tick(): Promise<void> {
    if (!settings.enabled) return;
    const inputs = await resolveInputs();
    const result = decide(inputs, core, {
      onDetect: settings.onDetect,
      autoStopDelayMs: settings.autoStopDelayMs,
      silenceTimeoutMs: settings.silenceTimeoutMs,
    });
    core = result.state;

    // Only surface a silence countdown once we're within the configured window.
    const effectiveSilenceCountdownMs = Math.min(
      settings.silenceCountdownMs,
      settings.silenceTimeoutMs,
    );
    silenceCountdownSec =
      result.silenceCountdownSec !== null &&
      result.silenceCountdownSec * 1000 <= effectiveSilenceCountdownMs
        ? result.silenceCountdownSec
        : null;

    const action = result.decision.action;
    if (action === "start") {
      await applyStart(result.decision.source);
    } else if (action === "prompt-start") {
      pendingSource = result.decision.source;
    } else if (action === "stop") {
      await applyStop();
    } else if (!inputs.recording && pendingSource !== null && core.promptPending === false) {
      // The signal cleared while a prompt was pending and unaccepted — dismiss it.
      pendingSource = null;
    }
    emit();
  }

  function startEngine(): void {
    if (!settings.enabled) {
      emit();
      return;
    }
    if (pollHandle !== null) return;
    pollHandle = setIntervalFn(() => void tick(), pollMs);
    // Fire one immediate tick so detection doesn't wait a full interval.
    void tick();
  }

  function stopEngine(): void {
    if (pollHandle !== null) {
      clearIntervalFn(pollHandle);
      pollHandle = null;
    }
  }

  return {
    start: startEngine,
    stop: stopEngine,

    getState(): AutoRecordState {
      return computeState();
    },

    onStateChange(cb: (state: AutoRecordState) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    applySettings(next: AutoRecordSettings): void {
      const was = settings.enabled;
      settings = autoRecordSettingsSchema.parse(next);
      if (settings.enabled && !was) {
        startEngine();
      } else if (!settings.enabled && was) {
        stopEngine();
        // Disabling does NOT stop an in-progress recording (manual control); it
        // just stops making decisions. Clear pending prompt + countdown.
        pendingSource = null;
        silenceCountdownSec = null;
        core = initialDecisionState();
      }
      emit();
    },

    async acceptPendingStart(): Promise<void> {
      if (pendingSource === null) return;
      const source = pendingSource;
      pendingSource = null;
      // Clear the prompt latch so the core won't re-prompt.
      core = { ...core, promptPending: false };
      await applyStart(source);
      emit();
    },

    dismissPendingStart(): void {
      pendingSource = null;
      core = { ...core, promptPending: false };
      emit();
    },

    tick,

    dispose(): void {
      stopEngine();
      unsubLifecycle();
      listeners.clear();
    },
  };
}

// Re-export the disabled baseline so the IPC layer can answer before the engine
// is constructed (defensive; the engine always exists in production).
export { disabledState as autoRecordDisabledState };
