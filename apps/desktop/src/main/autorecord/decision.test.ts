/**
 * Hermetic tests for the PURE auto-record decision core (PRD-11).
 *
 * The core is a deterministic function of its inputs (no I/O, no Date.now), so
 * this exercises it as an exhaustive truth table (nativeApp x mic x browser x
 * policy -> start/prompt-start/stop/none) plus the timer transitions (auto-stop
 * grace + silence stop) driven by a fixed `now`. NO real waiting.
 */
import { describe, expect, it } from "vitest";
import type { DetectionInputs } from "@loqui/shared";
import {
  decide,
  initialDecisionState,
  meetingPresent,
  type DecisionPolicy,
  type DecisionState,
} from "./decision.js";

const T0 = 1_000_000;

function inputs(over: Partial<DetectionInputs> = {}): DetectionInputs {
  return {
    nativeAppActive: false,
    micActive: false,
    browserInCall: false,
    recording: false,
    autoStarted: false,
    now: T0,
    ...over,
  };
}

const AUTO: DecisionPolicy = {
  onDetect: "auto",
  autoStopDelayMs: 5000,
  silenceTimeoutMs: 0,
};
const ASK: DecisionPolicy = { ...AUTO, onDetect: "ask" };

describe("meetingPresent — the present predicate", () => {
  it("is true for a live native call (app AND mic)", () => {
    expect(meetingPresent(inputs({ nativeAppActive: true, micActive: true }))).toEqual({
      present: true,
      source: "native-app",
    });
  });
  it("is FALSE for a native app with no mic (app up but no call)", () => {
    expect(meetingPresent(inputs({ nativeAppActive: true, micActive: false }))).toEqual({
      present: false,
      source: "none",
    });
  });
  it("is true for a browser in a call", () => {
    expect(meetingPresent(inputs({ browserInCall: true }))).toEqual({
      present: true,
      source: "browser",
    });
  });
  it("prefers native-app as the source when both fire", () => {
    expect(
      meetingPresent(inputs({ nativeAppActive: true, micActive: true, browserInCall: true })),
    ).toEqual({ present: true, source: "native-app" });
  });
});

describe("not recording — the start truth table", () => {
  const start = initialDecisionState();

  it("no signal -> none", () => {
    expect(decide(inputs(), start, AUTO).decision.action).toBe("none");
  });

  it("native call + policy auto -> start (source native-app)", () => {
    const r = decide(inputs({ nativeAppActive: true, micActive: true }), start, AUTO);
    expect(r.decision.action).toBe("start");
    expect(r.decision.source).toBe("native-app");
  });

  it("browser call + policy auto -> start (source browser)", () => {
    const r = decide(inputs({ browserInCall: true }), start, AUTO);
    expect(r.decision.action).toBe("start");
    expect(r.decision.source).toBe("browser");
  });

  it("native app WITHOUT mic + policy auto -> none (not a live call)", () => {
    const r = decide(inputs({ nativeAppActive: true, micActive: false }), start, AUTO);
    expect(r.decision.action).toBe("none");
  });

  it("detected + policy ask -> prompt-start, then latches (no re-prompt)", () => {
    const r1 = decide(inputs({ browserInCall: true }), start, ASK);
    expect(r1.decision.action).toBe("prompt-start");
    expect(r1.state.promptPending).toBe(true);
    // Next tick with the prompt still pending: no second prompt.
    const r2 = decide(inputs({ browserInCall: true }), r1.state, ASK);
    expect(r2.decision.action).toBe("none");
    expect(r2.state.promptPending).toBe(true);
  });

  it("prompt clears when the signal goes away before accept", () => {
    const r1 = decide(inputs({ browserInCall: true }), start, ASK);
    const r2 = decide(inputs({ browserInCall: false }), r1.state, ASK);
    expect(r2.state.promptPending).toBe(false);
  });
});

describe("recording — auto-stop grace timer (auto-started only)", () => {
  const recordingAuto = inputs({ recording: true, autoStarted: true });

  it("keeps recording while the signal is present", () => {
    const r = decide({ ...recordingAuto, browserInCall: true }, initialDecisionState(), AUTO);
    expect(r.decision.action).toBe("none");
  });

  it("does NOT stop immediately when the signal drops (within grace)", () => {
    // Signal drops at T0; grace is 5s. At T0+4s it should still be recording.
    const s0 = decide({ ...recordingAuto, browserInCall: false, now: T0 }, initialDecisionState(), AUTO);
    expect(s0.decision.action).toBe("none");
    const s1 = decide({ ...recordingAuto, browserInCall: false, now: T0 + 4000 }, s0.state, AUTO);
    expect(s1.decision.action).toBe("none");
  });

  it("stops once the grace delay elapses", () => {
    const s0 = decide({ ...recordingAuto, browserInCall: false, now: T0 }, initialDecisionState(), AUTO);
    const s1 = decide({ ...recordingAuto, browserInCall: false, now: T0 + 5000 }, s0.state, AUTO);
    expect(s1.decision.action).toBe("stop");
    expect(s1.decision.reason).toBe("meeting ended");
  });

  it("disarms the grace if the signal returns before it elapses (a blip)", () => {
    const s0 = decide({ ...recordingAuto, browserInCall: false, now: T0 }, initialDecisionState(), AUTO);
    // Signal returns at T0+2s.
    const s1 = decide({ ...recordingAuto, browserInCall: true, now: T0 + 2000 }, s0.state, AUTO);
    expect(s1.state.signalLostAt).toBeNull();
    // Later, well past the original deadline, still recording (timer was reset).
    const s2 = decide({ ...recordingAuto, browserInCall: true, now: T0 + 9000 }, s1.state, AUTO);
    expect(s2.decision.action).toBe("none");
  });
});

describe("recording — MANUAL meetings never auto-stop on signal loss", () => {
  it("a manually-started recording is not stopped by signal loss", () => {
    const manual = inputs({ recording: true, autoStarted: false });
    const s0 = decide({ ...manual, browserInCall: false, now: T0 }, initialDecisionState(), AUTO);
    const s1 = decide({ ...manual, browserInCall: false, now: T0 + 60_000 }, s0.state, AUTO);
    expect(s0.decision.action).toBe("none");
    expect(s1.decision.action).toBe("none");
  });
});

describe("silence auto-stop", () => {
  const silencePolicy: DecisionPolicy = {
    onDetect: "auto",
    autoStopDelayMs: 1_000_000, // huge, so only the silence timer fires
    silenceTimeoutMs: 60_000,
  };

  it("surfaces a countdown as silence accrues, then stops at the timeout", () => {
    // Recording (manual, to isolate from the signal-loss grace), no signal => silent.
    const rec = inputs({ recording: true, autoStarted: false, browserInCall: false });
    const s0 = decide({ ...rec, now: T0 }, initialDecisionState(), silencePolicy);
    expect(s0.decision.action).toBe("none");
    // 30s into silence: countdown shows ~30s remaining.
    const s1 = decide({ ...rec, now: T0 + 30_000 }, s0.state, silencePolicy);
    expect(s1.silenceCountdownSec).toBe(30);
    // At the timeout: stop with a silence reason.
    const s2 = decide({ ...rec, now: T0 + 60_000 }, s1.state, silencePolicy);
    expect(s2.decision.action).toBe("stop");
    expect(s2.decision.reason).toContain("silence");
  });

  it("resets the silence timer whenever the signal is present (activity)", () => {
    const rec = inputs({ recording: true, autoStarted: false });
    const s0 = decide({ ...rec, browserInCall: false, now: T0 }, initialDecisionState(), silencePolicy);
    // Activity at T0+30s resets lastActivityAt.
    const s1 = decide({ ...rec, browserInCall: true, now: T0 + 30_000 }, s0.state, silencePolicy);
    // Silence resumes; 30s later (T0+60s) is only 30s of NEW silence -> no stop.
    const s2 = decide({ ...rec, browserInCall: false, now: T0 + 60_000 }, s1.state, silencePolicy);
    expect(s2.decision.action).toBe("none");
  });

  it("is disabled when silenceTimeoutMs is 0 (never stops on silence)", () => {
    const rec = inputs({ recording: true, autoStarted: false, browserInCall: false });
    const s0 = decide({ ...rec, now: T0 }, initialDecisionState(), AUTO);
    const s1 = decide({ ...rec, now: T0 + 10_000_000 }, s0.state, AUTO);
    expect(s1.decision.action).toBe("none");
    expect(s1.silenceCountdownSec).toBeNull();
  });
});

describe("determinism", () => {
  it("is a pure function of its inputs + state", () => {
    const i = inputs({ nativeAppActive: true, micActive: true });
    const s: DecisionState = initialDecisionState();
    expect(decide(i, s, AUTO)).toEqual(decide(i, s, AUTO));
  });
});
