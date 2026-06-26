/**
 * Hermetic tests for the auto-record engine (PRD-11).
 *
 * The engine is driven with a fake PRD-3 lifecycle, fake OS/browser probes, an
 * injected clock, and a manual `tick()` (no real timers) — deterministic. Covers:
 * the `auto` vs `ask` branch; that the browser in-call signal flows from the
 * (faked) source into a start; that auto-stop + silence stop drive the lifecycle;
 * and that with auto-record DISABLED nothing fires (manual control unaffected).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoRecordSettingsSchema,
  type AutoRecordSettings,
  type BrowserCallState,
  type Meeting,
} from "@loqui/shared";
import { createAutoRecordEngine, type AutoRecordLifecycle } from "./engine.js";
import type { NativeMeetingProbe, NativeProbeSample } from "./detectors.js";
import type { BrowserCallSource } from "./browser-source.js";

function meeting(id: string, status: Meeting["status"] = "recording"): Meeting {
  const now = "2026-06-24T00:00:00.000Z";
  return {
    id,
    title: "",
    platform: null,
    startedAt: now,
    endedAt: null,
    status,
    kind: "meeting",
    participants: [],
    modelVersions: {},
    calendarAttendees: [],
    titleEdited: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** A fake lifecycle that records start/stop calls and tracks the active meeting. */
function fakeLifecycle(): AutoRecordLifecycle & {
  startCalls: Array<{ platform?: Meeting["platform"] }>;
  stopCalls: Array<{ id: string }>;
  setActive(m: Meeting | null): void;
} {
  let active: Meeting | null = null;
  const cbs = new Set<(m: Meeting) => void>();
  let n = 0;
  const startCalls: Array<{ platform?: Meeting["platform"] }> = [];
  const stopCalls: Array<{ id: string }> = [];
  return {
    startCalls,
    stopCalls,
    setActive(m) {
      active = m;
    },
    startMeeting(params) {
      startCalls.push(params ?? {});
      active = meeting(`m${++n}`, "recording");
      if (params?.platform) active = { ...active, platform: params.platform };
      for (const cb of cbs) cb(active);
      return Promise.resolve(active);
    },
    stopMeeting(params) {
      stopCalls.push(params);
      const stopped = active ? { ...active, status: "processing" as const } : meeting(params.id, "processing");
      active = null;
      for (const cb of cbs) cb(stopped);
      return Promise.resolve(stopped);
    },
    getActiveMeeting: () => active,
    onMeetingStatus(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}

function fakeNativeProbe(sample: NativeProbeSample): NativeMeetingProbe {
  return { sample: vi.fn(async () => sample) };
}

function fakeBrowserSource(initial: boolean): BrowserCallSource & { set(v: boolean): void } {
  let state: BrowserCallState = { inCall: initial, lastSeenAt: null };
  return {
    set(v) {
      state = { inCall: v, lastSeenAt: v ? new Date().toISOString() : null };
    },
    getBrowserCallState: () => state,
    onBrowserCallChange: () => () => {},
  };
}

const NO_NATIVE: NativeProbeSample = { appActive: false, micActive: false, matched: [] };

function settings(over: Partial<AutoRecordSettings> = {}): AutoRecordSettings {
  return autoRecordSettingsSchema.parse({ enabled: true, ...over });
}

// A controllable clock; tests advance it between ticks.
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
});

/** Build an engine with no real timers (interval fns are no-ops; we call tick()). */
function build(deps: {
  settings: AutoRecordSettings;
  lifecycle: AutoRecordLifecycle;
  nativeProbe: NativeMeetingProbe;
  browserSource: BrowserCallSource;
}) {
  return createAutoRecordEngine({
    ...deps,
    now,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
}

describe("auto policy — auto-start on detection", () => {
  it("starts a meeting when a native call is detected (auto)", async () => {
    const lifecycle = fakeLifecycle();
    const engine = build({
      settings: settings({ onDetect: "auto" }),
      lifecycle,
      nativeProbe: fakeNativeProbe({ appActive: true, micActive: true, matched: ["zoom.exe"] }),
      browserSource: fakeBrowserSource(false),
    });
    await engine.tick();
    expect(lifecycle.startCalls).toHaveLength(1);
    expect(engine.getState().recording).toBe(true);
    expect(engine.getState().autoStarted).toBe(true);
    expect(engine.getState().source).toBe("native-app");
  });

  it("starts a google-meet meeting when the BROWSER signal is in a call", async () => {
    const lifecycle = fakeLifecycle();
    const browser = fakeBrowserSource(true);
    const engine = build({
      settings: settings({ onDetect: "auto" }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: browser,
    });
    await engine.tick();
    expect(lifecycle.startCalls).toHaveLength(1);
    expect(lifecycle.startCalls[0]!.platform).toBe("google-meet");
    expect(engine.getState().source).toBe("browser");
  });
});

describe("ask policy — prompt, then accept", () => {
  it("does NOT start on detection; surfaces a `detected` phase", async () => {
    const lifecycle = fakeLifecycle();
    const engine = build({
      settings: settings({ onDetect: "ask" }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: fakeBrowserSource(true),
    });
    await engine.tick();
    expect(lifecycle.startCalls).toHaveLength(0);
    expect(engine.getState().phase).toBe("detected");
  });

  it("starts only when the prompt is accepted", async () => {
    const lifecycle = fakeLifecycle();
    const engine = build({
      settings: settings({ onDetect: "ask" }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: fakeBrowserSource(true),
    });
    await engine.tick();
    await engine.acceptPendingStart();
    expect(lifecycle.startCalls).toHaveLength(1);
    expect(engine.getState().recording).toBe(true);
  });

  it("dismiss clears the prompt without starting", async () => {
    const lifecycle = fakeLifecycle();
    const engine = build({
      settings: settings({ onDetect: "ask" }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: fakeBrowserSource(true),
    });
    await engine.tick();
    engine.dismissPendingStart();
    expect(engine.getState().phase).toBe("idle");
    expect(lifecycle.startCalls).toHaveLength(0);
  });
});

describe("auto-stop on signal loss (auto-started)", () => {
  it("stops the auto-started meeting after the configured grace delay", async () => {
    const lifecycle = fakeLifecycle();
    const browser = fakeBrowserSource(true);
    const engine = build({
      settings: settings({ onDetect: "auto", autoStopDelayMs: 5000 }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: browser,
    });
    await engine.tick(); // starts
    expect(lifecycle.startCalls).toHaveLength(1);
    // Call ends.
    browser.set(false);
    await engine.tick(); // arm grace at T0
    clock += 5000;
    await engine.tick(); // grace elapsed -> stop
    expect(lifecycle.stopCalls).toHaveLength(1);
    expect(engine.getState().recording).toBe(false);
  });
});

describe("silence auto-stop + countdown", () => {
  it("counts down and stops after the silence timeout (within the countdown window)", async () => {
    const lifecycle = fakeLifecycle();
    // Start it manually so the signal-loss grace doesn't also fire.
    const browser = fakeBrowserSource(false);
    lifecycle.setActive(meeting("manual", "recording"));
    const engine = build({
      settings: settings({
        onDetect: "auto",
        silenceTimeoutMs: 60_000,
        silenceCountdownMs: 30_000,
        autoStopDelayMs: 10_000_000,
      }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: browser,
    });
    await engine.tick(); // begins tracking silence at T0
    // 40s of silence: within the 30s countdown window (20s remain).
    clock += 40_000;
    await engine.tick();
    expect(engine.getState().phase).toBe("countdown");
    expect(engine.getState().silenceCountdownSec).toBe(20);
    // At the timeout, stop fires.
    clock += 20_000;
    await engine.tick();
    expect(lifecycle.stopCalls).toHaveLength(1);
  });

  it("clamps an oversized silence countdown window to the silence timeout", async () => {
    const lifecycle = fakeLifecycle();
    lifecycle.setActive(meeting("manual", "recording"));
    const engine = build({
      settings: settings({
        silenceTimeoutMs: 10_000,
        silenceCountdownMs: 30_000,
        autoStopDelayMs: 10_000_000,
      }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: fakeBrowserSource(false),
    });
    await engine.tick();
    expect(engine.getState().phase).toBe("countdown");
    expect(engine.getState().silenceCountdownSec).toBe(10);
  });
});

describe("disabled — manual control unaffected", () => {
  it("makes NO decisions when auto-record is disabled (default)", async () => {
    const lifecycle = fakeLifecycle();
    const engine = build({
      settings: autoRecordSettingsSchema.parse({}), // enabled defaults to false
      lifecycle,
      nativeProbe: fakeNativeProbe({ appActive: true, micActive: true, matched: ["zoom.exe"] }),
      browserSource: fakeBrowserSource(true),
    });
    engine.start();
    await engine.tick();
    expect(lifecycle.startCalls).toHaveLength(0);
    expect(engine.getState().phase).toBe("disabled");
  });

  it("does not probe the OS when disabled", async () => {
    const probe = fakeNativeProbe({ appActive: true, micActive: true, matched: [] });
    const engine = build({
      settings: autoRecordSettingsSchema.parse({}),
      lifecycle: fakeLifecycle(),
      nativeProbe: probe,
      browserSource: fakeBrowserSource(true),
    });
    await engine.tick();
    expect(probe.sample).not.toHaveBeenCalled();
  });

  it("disabling live stops decisions but never stops an in-progress recording", async () => {
    const lifecycle = fakeLifecycle();
    const browser = fakeBrowserSource(true);
    const engine = build({
      settings: settings({ onDetect: "auto" }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: browser,
    });
    await engine.tick(); // auto-starts
    expect(engine.getState().recording).toBe(true);
    // User disables auto-record mid-recording.
    engine.applySettings(settings({ enabled: false }));
    browser.set(false);
    clock += 100_000;
    await engine.tick();
    // No auto-stop fired; the recording is left for the user to stop manually.
    expect(lifecycle.stopCalls).toHaveLength(0);
    expect(engine.getState().enabled).toBe(false);
  });
});

describe("manual-started meetings are never auto-stopped", () => {
  it("leaves a manually-started recording alone when the signal clears", async () => {
    const lifecycle = fakeLifecycle();
    lifecycle.setActive(meeting("manual", "recording"));
    const engine = build({
      settings: settings({ onDetect: "auto", autoStopDelayMs: 1000 }),
      lifecycle,
      nativeProbe: fakeNativeProbe(NO_NATIVE),
      browserSource: fakeBrowserSource(false),
    });
    await engine.tick();
    clock += 60_000;
    await engine.tick();
    expect(lifecycle.stopCalls).toHaveLength(0);
    expect(engine.getState().recording).toBe(true);
    expect(engine.getState().autoStarted).toBe(false);
  });
});
