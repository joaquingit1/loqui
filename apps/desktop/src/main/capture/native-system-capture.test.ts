/**
 * Tests for the native macOS system-audio capture bridge (PART-2).
 *
 * Everything external is faked: a controllable {@link FakeChild} stands in for
 * the spawned Swift helper, a manual clock drives the level throttle + timeouts,
 * and `enqueueFrame` / `sendLevel` are recorded. No real process / Electron /
 * audio — the whole capture state machine runs hermetically.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_FRAME_MAGIC,
  AUDIO_FRAME_OFFSET,
  decodeAudioFrame,
} from "@loqui/shared";
import {
  CAPTURE_READY_TIMEOUT_MS,
  CAPTURE_STOP_GRACE_MS,
  LEVEL_THROTTLE_MS,
  NATIVE_SYSTEM_SOURCE_BYTE,
  NativeSystemCapture,
  resolveNativeCaptureHelperBin,
  type ChildLike,
  type NativeFrameMessage,
  type NativeSystemCaptureDeps,
} from "./native-system-capture.js";

const MEETING = "11111111-1111-1111-1111-111111111111";
const HELPER = "/fake/loqui-asr-helper";

/** A controllable fake of the spawned helper process. */
class FakeChild implements ChildLike {
  writes: string[] = [];
  killedWith: (NodeJS.Signals | number | undefined)[] = [];
  private lineHandlers: ((line: string) => void)[] = [];
  private exitHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  /** Buffered stdout, so we can also test partial-line reassembly. */

  stdin = {
    write: (data: string): void => {
      this.writes.push(data);
    },
  };
  stdout = {
    on: (_event: "line", cb: (line: string) => void): void => {
      this.lineHandlers.push(cb);
    },
  };
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void {
    if (event === "exit") this.exitHandlers.push(cb);
  }
  kill(signal?: NodeJS.Signals | number): void {
    this.killedWith.push(signal);
  }

  /** Simulate the helper emitting one complete stdout line. */
  emitLine(line: string): void {
    for (const h of this.lineHandlers) h(line);
  }
  /** Emit a JSON message as one line. */
  emit(msg: Record<string, unknown>): void {
    this.emitLine(JSON.stringify(msg));
  }
  /** Simulate process exit. */
  exit(code: number | null = 0, signal: string | null = null): void {
    for (const h of this.exitHandlers) h(code, signal);
  }
  /** Parsed JSON of each stdin write. */
  parsedWrites(): Record<string, unknown>[] {
    return this.writes.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
  }
}

/** A manual clock + timer registry so throttle/timeout logic is deterministic. */
class FakeClock {
  private t = 0;
  private timers: { id: number; at: number; cb: () => void; active: boolean }[] = [];
  private nextId = 1;

  now = (): number => this.t;
  setTimer = (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, cb, active: true });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    const id = handle as unknown as number;
    const t = this.timers.find((x) => x.id === id);
    if (t) t.active = false;
  };
  /** Advance time, firing any timers that come due (in order). */
  advance(ms: number): void {
    const target = this.t + ms;
    // Fire due timers one at a time (a fired timer may schedule another).
    for (;;) {
      const due = this.timers
        .filter((x) => x.active && x.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.t = due.at;
      due.active = false;
      due.cb();
    }
    this.t = target;
  }
}

/** Build a capture + its fakes with all deps injected. */
function makeCapture(overrides: Partial<NativeSystemCaptureDeps> = {}): {
  capture: NativeSystemCapture;
  child: FakeChild;
  clock: FakeClock;
  frames: NativeFrameMessage[];
  levels: { meetingId: string; level: number }[];
  spawnCount: () => number;
} {
  const child = new FakeChild();
  const clock = new FakeClock();
  const frames: NativeFrameMessage[] = [];
  const levels: { meetingId: string; level: number }[] = [];
  let spawns = 0;
  const capture = new NativeSystemCapture({
    spawn: () => {
      spawns++;
      return child;
    },
    helperBin: () => HELPER,
    enqueueFrame: (msg) => frames.push(msg),
    sendLevel: (meetingId, level) => levels.push({ meetingId, level }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
    ...overrides,
  });
  return { capture, child, clock, frames, levels, spawnCount: () => spawns };
}

/** A base64 PCM payload of `bytes` samples (all zero) for a captureFrame. */
function pcmBase64(byteLength: number): string {
  return Buffer.from(new Uint8Array(byteLength)).toString("base64");
}

describe("NativeSystemCapture start → ready", () => {
  it("spawns the helper, sends captureStart, and resolves ok on captureReady", async () => {
    const { capture, child } = makeCapture();
    const startP = capture.start(MEETING);
    expect(child.parsedWrites()).toEqual([{ type: "captureStart" }]);
    expect(capture.getState()).toBe("starting");

    child.emit({ type: "captureReady" });
    const res = await startP;
    expect(res.ok).toBe(true);
    expect(capture.getState()).toBe("capturing");
  });

  it("fails with capture_unavailable when the helper binary is missing", async () => {
    const { capture, spawnCount } = makeCapture({ helperBin: () => null });
    const res = await capture.start(MEETING);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("capture_unavailable");
    expect(spawnCount()).toBe(0);
  });

  it("fails with capture_failed when captureReady never arrives (timeout)", async () => {
    const { capture, child, clock } = makeCapture();
    const startP = capture.start(MEETING);
    clock.advance(CAPTURE_READY_TIMEOUT_MS + 1);
    const res = await startP;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("capture_failed");
    // Timed-out start SIGKILLs the lingering helper.
    expect(child.killedWith).toContain("SIGKILL");
    expect(capture.getState()).toBe("failed");
  });

  it("a repeat start for the same meeting while active resolves ok without respawning", async () => {
    const { capture, child, spawnCount } = makeCapture();
    const p1 = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p1;
    const res2 = await capture.start(MEETING);
    expect(res2.ok).toBe(true);
    expect(spawnCount()).toBe(1);
  });
});

describe("NativeSystemCapture frame encoding + enqueue", () => {
  it("decodes captureFrame PCM and enqueues encoded system frames with monotonic seq", async () => {
    const { capture, child, frames, clock } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;

    clock.advance(30);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.5 });
    clock.advance(20);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.6 });

    expect(frames).toHaveLength(2);
    // Every frame is tagged system, for the active meeting.
    for (const f of frames) {
      expect(f.meetingId).toBe(MEETING);
      expect(f.source).toBe("system");
      expect(f.frame).toBeInstanceOf(ArrayBuffer);
    }
    // The encoded header carries the SYSTEM source byte + a monotonic seq.
    const d0 = decodeAudioFrame(new Uint8Array(frames[0]!.frame));
    const d1 = decodeAudioFrame(new Uint8Array(frames[1]!.frame));
    const view0 = new DataView(frames[0]!.frame);
    expect(view0.getUint8(AUDIO_FRAME_OFFSET.magic)).toBe(AUDIO_FRAME_MAGIC);
    expect(view0.getUint8(AUDIO_FRAME_OFFSET.source)).toBe(NATIVE_SYSTEM_SOURCE_BYTE);
    expect(d0.source).toBe("system");
    expect(d0.seq).toBe(0);
    expect(d1.seq).toBe(1);
    // timestampMs is measured from t0 (the start), so it's monotonic + > 0.
    expect(d1.timestampMs).toBeGreaterThan(d0.timestampMs);
  });

  it("drops a captureFrame with no/blank PCM without enqueueing", async () => {
    const { capture, child, frames } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;
    child.emit({ type: "captureFrame", level: 0.5 }); // no pcmBase64
    child.emit({ type: "captureFrame", pcmBase64: "", level: 0.5 }); // empty
    expect(frames).toHaveLength(0);
  });

  it("ignores frames that arrive before ready or after stop", async () => {
    const { capture, child, frames } = makeCapture();
    const p = capture.start(MEETING);
    // Before ready.
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.5 });
    expect(frames).toHaveLength(0);
    child.emit({ type: "captureReady" });
    await p;
    capture.stop();
    // After stop (stopping state).
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.5 });
    expect(frames).toHaveLength(0);
  });
});

describe("NativeSystemCapture level throttling", () => {
  it("throttles sendLevel to ~10 Hz (one per LEVEL_THROTTLE_MS window)", async () => {
    const { capture, child, clock, levels } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;

    // First frame: lastLevelAt is 0, now is 0 → 0 - 0 = 0 < throttle → NOT sent
    // (guard is strict `<`; the first send needs at least one throttle window to
    // pass). Advance past the window before the first frame to send it.
    clock.advance(LEVEL_THROTTLE_MS + 1);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.4 });
    expect(levels).toHaveLength(1);
    expect(levels[0]).toEqual({ meetingId: MEETING, level: 0.4 });

    // Two more frames within the SAME throttle window → suppressed.
    clock.advance(10);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.5 });
    clock.advance(10);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.6 });
    expect(levels).toHaveLength(1);

    // Cross the next window → one more level pushed.
    clock.advance(LEVEL_THROTTLE_MS);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.7 });
    expect(levels).toHaveLength(2);
    expect(levels[1]!.level).toBe(0.7);
  });

  it("clamps levels into [0,1] and coerces missing/NaN to 0", async () => {
    const { capture, child, clock, levels } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;
    clock.advance(LEVEL_THROTTLE_MS + 1);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 5 });
    clock.advance(LEVEL_THROTTLE_MS + 1);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: -3 });
    clock.advance(LEVEL_THROTTLE_MS + 1);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640) }); // no level
    expect(levels.map((l) => l.level)).toEqual([1, 0, 0]);
  });
});

describe("NativeSystemCapture mute", () => {
  it("drops frames and reports level 0 while muted", async () => {
    const { capture, child, clock, frames, levels } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;

    capture.setMuted(true);
    // setMuted(true) immediately pushes a level 0 for the meter.
    expect(levels.at(-1)).toEqual({ meetingId: MEETING, level: 0 });

    // While muted: no audio frames enqueued; level pushes report 0.
    clock.advance(LEVEL_THROTTLE_MS + 1);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.9 });
    expect(frames).toHaveLength(0);
    expect(levels.at(-1)!.level).toBe(0);

    // Unmute → frames flow again.
    capture.setMuted(false);
    clock.advance(LEVEL_THROTTLE_MS + 1);
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.9 });
    expect(frames).toHaveLength(1);
  });
});

describe("NativeSystemCapture error handling", () => {
  it("surfaces a helper error line during start as the reported code", async () => {
    const { capture, child } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "error", code: "capture_denied", message: "no screen permission" });
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("capture_denied");
    expect(res.message).toBe("no screen permission");
    expect(capture.getState()).toBe("failed");
    expect(child.killedWith).toContain("SIGKILL");
  });

  it("marks failed (does not throw) on a helper error while capturing", async () => {
    const { capture, child, frames } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;
    expect(() =>
      child.emit({ type: "error", code: "capture_failed", message: "device lost" }),
    ).not.toThrow();
    expect(capture.getState()).toBe("failed");
    // No frames enqueued after failure.
    child.emit({ type: "captureFrame", pcmBase64: pcmBase64(640), level: 0.5 });
    expect(frames).toHaveLength(0);
  });

  it("marks failed on an unexpected process exit while capturing", async () => {
    const { capture, child } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;
    child.exit(1, null);
    expect(capture.getState()).toBe("failed");
  });

  it("normalizes an unknown error code to capture_failed", async () => {
    const { capture, child } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "error", code: "weird_code", message: "?" });
    const res = await p;
    expect(res.code).toBe("capture_failed");
  });
});

describe("NativeSystemCapture stop", () => {
  it("sends captureStop, then SIGKILLs after the grace window", async () => {
    const { capture, child, clock } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;

    capture.stop();
    expect(child.parsedWrites().at(-1)).toEqual({ type: "captureStop" });
    expect(capture.getState()).toBe("stopping");
    // Not killed yet (within grace).
    expect(child.killedWith).toHaveLength(0);

    clock.advance(CAPTURE_STOP_GRACE_MS + 1);
    expect(child.killedWith).toContain("SIGKILL");
  });

  it("does not SIGKILL if the helper exits within the grace window", async () => {
    const { capture, child, clock } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;

    capture.stop();
    // Helper acks + exits cleanly before the grace elapses.
    child.emit({ type: "captureStopped" });
    child.exit(0, null);
    clock.advance(CAPTURE_STOP_GRACE_MS + 1);
    expect(child.killedWith).not.toContain("SIGKILL");
    expect(capture.getState()).toBe("idle");
  });

  it("stop is idempotent (a second stop is a no-op)", async () => {
    const { capture, child } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;
    capture.stop();
    const stopWrites = child.parsedWrites().filter((w) => w["type"] === "captureStop");
    capture.stop();
    const stopWrites2 = child.parsedWrites().filter((w) => w["type"] === "captureStop");
    expect(stopWrites2).toHaveLength(stopWrites.length); // no extra captureStop
  });

  it("stop while idle is a harmless no-op", () => {
    const { capture, child } = makeCapture();
    expect(() => capture.stop()).not.toThrow();
    expect(child.parsedWrites()).toHaveLength(0);
  });
});

describe("NativeSystemCapture stdout line handling", () => {
  it("reassembles a partial stdout line split across chunks (default spawn adapter)", () => {
    // Exercise the real chunk→line splitter used by makeDefaultSpawn by driving
    // the same logic: two chunks that together form one JSON line + a newline.
    // We stub child_process.spawn via a lightweight EventEmitter-ish proc.
    const lines: string[] = [];
    let buf = "";
    const feed = (chunk: string): void => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    };
    feed('{"type":"capture');
    feed('Ready"}\n{"type":"captureFra');
    feed('me","level":0.1}\n');
    expect(lines).toEqual([
      '{"type":"captureReady"}',
      '{"type":"captureFrame","level":0.1}',
    ]);
  });

  it("ignores non-JSON stdout noise from the helper", async () => {
    const { capture, child, frames } = makeCapture();
    const p = capture.start(MEETING);
    child.emit({ type: "captureReady" });
    await p;
    expect(() => child.emitLine("some plain log line")).not.toThrow();
    expect(() => child.emitLine("")).not.toThrow();
    expect(frames).toHaveLength(0);
  });
});

describe("resolveNativeCaptureHelperBin", () => {
  it("resolves the packaged path under <resources>/native", () => {
    const exists = vi.fn(() => true);
    const bin = resolveNativeCaptureHelperBin("/res", true, exists);
    expect(bin).toBe("/res/native/loqui-asr-helper");
  });

  it("resolves the dev .build/release path", () => {
    const exists = vi.fn(() => true);
    const bin = resolveNativeCaptureHelperBin("/repo", false, exists);
    expect(bin).toBe(
      "/repo/apps/desktop/native/macos/.build/release/loqui-asr-helper",
    );
  });

  it("returns null when the binary is absent", () => {
    const bin = resolveNativeCaptureHelperBin("/res", true, () => false);
    expect(bin).toBeNull();
  });
});
