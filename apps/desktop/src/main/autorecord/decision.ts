/**
 * PRD-11 — the PURE auto-record decision core (the heart of detection).
 *
 * A platform-AGNOSTIC, deterministic state machine: given the instantaneous
 * {@link DetectionInputs} (resolved booleans + a clock) plus its own carried
 * {@link DecisionState}, it emits a {@link DetectionDecision} (start / prompt-start
 * / stop / none) and the next state. NO I/O, NO `Date.now`, NO randomness — every
 * timer is driven by the injected `now`, so the whole core is exhaustively
 * fixture-testable via a truth table.
 *
 * ## The truth table (per tick)
 * "A meeting is present" === a native call is live (`nativeAppActive && micActive`)
 * OR a browser tab is in a call (`browserInCall`). From there:
 *
 *   present & !recording          -> policy `auto` => `start`; `ask` => `prompt-start`
 *   !present & recording(auto)    -> arm the auto-stop grace; `stop` once it elapses
 *   present again before grace    -> disarm (a blip never ends the meeting)
 *   recording(manual)             -> NEVER auto-stop (manual control is sacrosanct)
 *   recording & silence elapsed   -> `stop` (silence auto-stop)
 *
 * ## Invariants
 * - NEVER blocks manual control: the core only ever EMITS a decision; the engine
 *   applies it via the normal PRD-3 lifecycle, and a manual start/stop simply
 *   updates `recording`/`autoStarted` on the next tick.
 * - NEVER auto-stops a manually-started meeting (`autoStarted === false`).
 * - A `prompt-start` is emitted at most once per detection episode (it latches in
 *   state until the meeting starts or the signal clears) so the engine doesn't
 *   re-prompt every tick.
 */
import {
  detectionInputsSchema,
  type AutoRecordSettings,
  type DetectionDecision,
  type DetectionInputs,
  type DetectionSource,
} from "@loqui/shared";

/**
 * The minimal carried state between ticks (the engine owns one instance per
 * recording session). All epoch-ms timestamps come from `inputs.now`.
 */
export interface DecisionState {
  /** When the meeting-present signal first dropped while recording (auto), else null. */
  signalLostAt: number | null;
  /** When activity (speech/audio) was last observed while recording, else null. */
  lastActivityAt: number | null;
  /** Whether a `prompt-start` is currently latched (awaiting accept / signal clear). */
  promptPending: boolean;
}

/** The initial carried state (no timers armed, no prompt pending). */
export function initialDecisionState(): DecisionState {
  return { signalLostAt: null, lastActivityAt: null, promptPending: false };
}

/** The policy slice the core needs (timers + onDetect). Defaulted by the schema upstream. */
export interface DecisionPolicy {
  onDetect: AutoRecordSettings["onDetect"];
  autoStopDelayMs: number;
  silenceTimeoutMs: number;
}

export interface DecisionResult {
  decision: DetectionDecision;
  state: DecisionState;
  /**
   * Seconds remaining until a silence auto-stop fires, or null when no silence
   * countdown is active. Surfaced so the engine/UI can render a visible countdown
   * without re-deriving the timer.
   */
  silenceCountdownSec: number | null;
}

/** Is a meeting present this tick? Native call live OR browser tab in a call. */
export function meetingPresent(inputs: DetectionInputs): {
  present: boolean;
  source: DetectionSource;
} {
  const nativeCall = inputs.nativeAppActive && inputs.micActive;
  if (nativeCall) return { present: true, source: "native-app" };
  if (inputs.browserInCall) return { present: true, source: "browser" };
  return { present: false, source: "none" };
}

function none(state: DecisionState, countdown: number | null): DecisionResult {
  return {
    decision: { action: "none", source: "none", reason: "" },
    state,
    silenceCountdownSec: countdown,
  };
}

/**
 * The pure decision step. Returns the decision for this tick, the next carried
 * state, and the live silence-countdown (seconds) if any.
 *
 * The engine calls this every tick with freshly-resolved inputs; it then applies
 * `decision.action` via the PRD-3 controller (start/stop) and persists the
 * returned `state` for the next tick. `silenceTimeoutMs <= 0` disables the
 * silence stop entirely.
 */
export function decide(
  rawInputs: DetectionInputs,
  state: DecisionState,
  policy: DecisionPolicy,
): DecisionResult {
  const inputs = detectionInputsSchema.parse(rawInputs);
  const { present, source } = meetingPresent(inputs);

  // --- Not recording: detection decides whether to start ----------------------
  if (!inputs.recording) {
    // Reset any recording-scoped timers; we're idle.
    if (!present) {
      // No meeting, not recording: clear any latched prompt and idle.
      return none(
        { signalLostAt: null, lastActivityAt: null, promptPending: false },
        null,
      );
    }
    // A meeting is present and we're not recording.
    if (policy.onDetect === "auto") {
      return {
        decision: {
          action: "start",
          source,
          reason: source === "native-app" ? "native call active" : "browser in call",
        },
        state: { signalLostAt: null, lastActivityAt: null, promptPending: false },
        silenceCountdownSec: null,
      };
    }
    // policy `ask`: emit prompt-start at most once per episode (latch it).
    if (state.promptPending) {
      // Already prompting — do nothing further until accepted or signal clears.
      return none({ ...state }, null);
    }
    return {
      decision: {
        action: "prompt-start",
        source,
        reason: source === "native-app" ? "native call detected" : "browser call detected",
      },
      state: { signalLostAt: null, lastActivityAt: null, promptPending: true },
      silenceCountdownSec: null,
    };
  }

  // --- Recording: maybe auto-stop (signal-loss grace OR silence) ---------------
  // Clear any pending prompt (we are recording now).
  let next: DecisionState = { ...state, promptPending: false };

  // Track activity for the silence stop. We treat "a meeting signal is present"
  // (native mic active / browser in call) as the activity proxy: when the call is
  // live, audio is flowing; when every signal is gone, silence accrues. The
  // engine may refine `lastActivityAt` via richer audio-level inputs later, but
  // the present signal is a sound, deterministic floor.
  if (present) {
    next = { ...next, lastActivityAt: inputs.now, signalLostAt: null };
  } else if (next.lastActivityAt === null) {
    // First observed silence while recording.
    next = { ...next, lastActivityAt: inputs.now };
  }

  // Silence auto-stop (applies to BOTH auto- and manually-started recordings;
  // it's an explicit user-configured idle stop, not a detection-driven one).
  const silenceOn = policy.silenceTimeoutMs > 0;
  let silenceCountdownSec: number | null = null;
  if (silenceOn && !present && next.lastActivityAt !== null) {
    const idleMs = inputs.now - next.lastActivityAt;
    const remainingMs = policy.silenceTimeoutMs - idleMs;
    if (remainingMs <= 0) {
      return {
        decision: {
          action: "stop",
          source: "none",
          reason: `silence ${Math.round(policy.silenceTimeoutMs / 1000)}s`,
        },
        state: { signalLostAt: null, lastActivityAt: null, promptPending: false },
        silenceCountdownSec: null,
      };
    }
    silenceCountdownSec = Math.ceil(remainingMs / 1000);
  }

  // Signal-loss auto-stop ONLY applies to AUTO-started recordings — a manually
  // started meeting is never auto-stopped by signal loss (manual is sacrosanct).
  if (!present && inputs.autoStarted) {
    const lostAt = next.signalLostAt ?? inputs.now;
    if (next.signalLostAt === null) {
      next = { ...next, signalLostAt: lostAt };
    }
    const goneMs = inputs.now - lostAt;
    if (goneMs >= policy.autoStopDelayMs) {
      return {
        decision: { action: "stop", source: "none", reason: "meeting ended" },
        state: { signalLostAt: null, lastActivityAt: null, promptPending: false },
        silenceCountdownSec: null,
      };
    }
  } else if (present) {
    // Signal back before the grace elapsed — disarm the auto-stop.
    next = { ...next, signalLostAt: null };
  }

  return none(next, silenceCountdownSec);
}
