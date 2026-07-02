/**
 * Native macOS system-audio capture bridge (PART-2 of the system-audio fix).
 *
 * ## Why this exists
 *
 * Electron's `getDisplayMedia({ audio: "loopback" })` system-audio path is
 * WINDOWS-ONLY. On macOS it never yields a real system-audio track, so "They"
 * (system) capture through the renderer never worked. Instead, on macOS the
 * MAIN process spawns the Swift ASR helper in a dedicated CAPTURE mode
 * (ScreenCaptureKit, added in PART-1), reads its PCM over stdio, and injects it
 * into the EXISTING sidecar path as `source:"system"` binary frames — exactly
 * the frames the renderer would otherwise have produced.
 *
 * This module owns ONLY the helper<->main bridge: spawn the helper, drive its
 * capture protocol, decode its PCM, re-encode it as the shared binary frame
 * (`encodeAudioFrame`), and hand each frame to the orchestrator's
 * `enqueueFrame` (the very same bounded-queue path the renderer frames take). It
 * does NOT talk to the sidecar directly — the caller (audio/register.ts) still
 * drives `orchestrator.start`/`stop` for the `audioStart`/`audioStop` control
 * frames, so the sidecar sees an ordinary system source.
 *
 * ## Helper stdio protocol (JSON lines, verbatim contract)
 *
 *   host -> helper: {"type":"captureStart"} / {"type":"captureStop"}
 *   helper -> host: {"type":"captureReady"}                         (once, then)
 *                   {"type":"captureFrame","pcmBase64":"...","level":0.42}  (stream)
 *                   {"type":"captureStopped"}                       (terminal)
 *                   {"type":"error","code":"capture_unavailable"|
 *                                          "capture_denied"|
 *                                          "capture_failed","message":"..."}
 *
 * PCM is pcm_s16le, 16 kHz MONO, ~10–100 ms per frame.
 *
 * ## Testability
 *
 * Everything external is injected (`spawn`, `helperBin`, `enqueueFrame`,
 * `sendLevel`, `now`) so the whole state machine is exercised with a fake child
 * — no real process, no Electron, no audio. The default `spawn` wraps Node's
 * `child_process.spawn` and adapts its stdout stream to the line-oriented
 * {@link ChildLike} seam (handling partial lines).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AUDIO_FRAME_SOURCE, encodeAudioFrame } from "@loqui/shared";

/** How long we wait for the helper's `captureReady` before failing the start. */
export const CAPTURE_READY_TIMEOUT_MS = 10_000 as const;
/** Grace period after `captureStop` before we SIGKILL a lingering helper. */
export const CAPTURE_STOP_GRACE_MS = 2_000 as const;
/** Minimum interval between `sendLevel` pushes (~10 Hz throttle). */
export const LEVEL_THROTTLE_MS = 100 as const;

/** Stable failure codes surfaced by the native capture. Mirrors the helper's. */
export type NativeCaptureErrorCode =
  | "capture_unavailable"
  | "capture_denied"
  | "capture_failed";

/**
 * Minimal child-process seam. The default impl wraps `child_process.spawn`;
 * tests pass a fake. `stdout` is a LINE source (already split on `\n`) so the
 * chunk->line reassembly lives in one place (the default spawn adapter).
 */
export interface ChildLike {
  stdin: { write(data: string): void };
  /** Emits one decoded JSON-line string per `data` event; also `error`/`close`. */
  stdout: {
    on(event: "line", cb: (line: string) => void): void;
  };
  /** Process-level exit (code|null, signal|null). */
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
  /** Send a signal (default SIGTERM); we escalate to SIGKILL after the grace. */
  kill(signal?: NodeJS.Signals | number): void;
}

/** One frame message handed to the orchestrator (matches its `enqueueFrame`). */
export interface NativeFrameMessage {
  meetingId: string;
  source: "system";
  frame: ArrayBuffer;
}

/** Injected dependencies — all external effects live behind this seam. */
export interface NativeSystemCaptureDeps {
  /** Spawn the capture helper in capture mode. */
  spawn: (bin: string) => ChildLike;
  /**
   * Resolve the capture helper binary path (SAME resolution main uses for
   * `LOQUI_ASR_HELPER_BIN`). Returns null when unavailable (no helper on disk)
   * -> start fails with `capture_unavailable`.
   */
  helperBin: () => string | null;
  /**
   * Hand one decoded+re-encoded system frame to the orchestrator's bounded
   * queue (the SAME path renderer frames take). Never throws on the hot path.
   */
  enqueueFrame: (msg: NativeFrameMessage) => void;
  /** Push a throttled 0..1 level for the active meeting's "They" meter. */
  sendLevel: (meetingId: string, level: number) => void;
  /** Monotonic clock in ms; defaults to `Date.now`. Injected for tests. */
  now?: () => number;
  /** Schedule a callback after `ms`; defaults to `setTimeout`. Injected for tests. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Cancel a scheduled timer; defaults to `clearTimeout`. */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Non-fatal log sink (helper errors / unexpected exits). Defaults to console.error. */
  log?: (msg: string) => void;
}

/** Lifecycle phase of the native capture. */
export type NativeCaptureState =
  | "idle"
  | "starting" // spawned, awaiting captureReady
  | "capturing" // ready; streaming frames
  | "stopping" // captureStop sent, awaiting exit / grace
  | "failed"; // helper error or unexpected exit while active

/** Result of {@link NativeSystemCapture.start}. */
export interface NativeCaptureStartResult {
  ok: boolean;
  /** {@link NativeCaptureErrorCode} on failure. */
  code?: NativeCaptureErrorCode;
  message?: string;
}

/**
 * Bridges the Swift capture helper's PCM into the sidecar path as system frames.
 * One instance owns AT MOST one active helper process at a time; `start` after a
 * prior `stop` spins up a fresh dedicated process (it never shares the sidecar's
 * ASR helper instance).
 */
export class NativeSystemCapture {
  private readonly deps: Required<
    Pick<NativeSystemCaptureDeps, "now" | "setTimer" | "clearTimer" | "log">
  > &
    NativeSystemCaptureDeps;

  private state: NativeCaptureState = "idle";
  private child: ChildLike | null = null;
  private meetingId: string | null = null;
  private muted = false;
  private seq = 0;
  private t0 = 0;
  private lastLevelAt = 0;
  private readyResolve: ((r: NativeCaptureStartResult) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: NativeSystemCaptureDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      setTimer: deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h)),
      log: deps.log ?? ((msg) => console.error("[loqui][native-capture]", msg)),
    };
  }

  /** Current lifecycle phase (idle/starting/capturing/stopping/failed). */
  getState(): NativeCaptureState {
    return this.state;
  }

  /** Whether a helper is actively (or nearly) capturing for this instance. */
  isActive(): boolean {
    return this.state === "starting" || this.state === "capturing";
  }

  /**
   * Spawn the helper in capture mode, send `captureStart`, and resolve once it
   * replies `captureReady` (or reject-shaped on timeout / helper error / no
   * binary). On success frames begin flowing to `enqueueFrame`. Idempotent-ish:
   * a start while already active resolves ok immediately (does not respawn).
   */
  start(meetingId: string): Promise<NativeCaptureStartResult> {
    if (this.isActive() && this.meetingId === meetingId) {
      return Promise.resolve({ ok: true });
    }
    // A start for a different meeting (or after failure) begins clean.
    if (this.child) this.hardStop();

    const bin = this.deps.helperBin();
    if (!bin) {
      this.state = "failed";
      return Promise.resolve({
        ok: false,
        code: "capture_unavailable",
        message: "native capture helper binary not found",
      });
    }

    this.meetingId = meetingId;
    this.muted = false;
    this.seq = 0;
    this.t0 = this.deps.now();
    this.lastLevelAt = 0;
    this.state = "starting";

    let child: ChildLike;
    try {
      child = this.deps.spawn(bin);
    } catch (err) {
      this.state = "failed";
      return Promise.resolve({
        ok: false,
        code: "capture_failed",
        message: `failed to spawn capture helper: ${errMsg(err)}`,
      });
    }
    this.child = child;

    const ready = new Promise<NativeCaptureStartResult>((resolve) => {
      this.readyResolve = resolve;
    });

    child.stdout.on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => this.onExit(code, signal));

    // Fail if captureReady never arrives.
    this.readyTimer = this.deps.setTimer(() => {
      if (this.state === "starting") {
        this.settleReady({
          ok: false,
          code: "capture_failed",
          message: "timed out waiting for captureReady",
        });
        this.hardStop("failed");
      }
    }, CAPTURE_READY_TIMEOUT_MS);

    this.write({ type: "captureStart" });
    return ready;
  }

  /**
   * Stop capture: send `captureStop`, then SIGKILL after the grace window if the
   * helper hasn't exited. Idempotent — a stop while idle is a no-op.
   */
  stop(): void {
    if (this.state === "idle" || this.state === "failed") {
      // Nothing active; still ensure any lingering child is gone.
      if (this.child) this.hardStop("idle");
      return;
    }
    if (this.state === "stopping") return;
    this.state = "stopping";
    this.write({ type: "captureStop" });
    // Escalate to SIGKILL if the helper doesn't exit within the grace period.
    if (this.stopTimer) this.deps.clearTimer(this.stopTimer);
    this.stopTimer = this.deps.setTimer(() => {
      if (this.child) this.child.kill("SIGKILL");
    }, CAPTURE_STOP_GRACE_MS);
  }

  /** Mute/unmute: while muted, frames are dropped and level pushes report 0. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    // On mute, immediately reflect silence so the meter doesn't hold a stale level.
    if (muted && this.meetingId) {
      this.deps.sendLevel(this.meetingId, 0);
      this.lastLevelAt = this.deps.now();
    }
  }

  // --- internals -----------------------------------------------------------

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { type?: string; pcmBase64?: string; level?: number; code?: string; message?: string };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      // Non-JSON stdout noise (helper logging) — ignore.
      return;
    }
    switch (msg.type) {
      case "captureReady":
        if (this.state === "starting") {
          this.state = "capturing";
          this.settleReady({ ok: true });
        }
        return;
      case "captureFrame":
        this.onFrame(msg.pcmBase64, msg.level);
        return;
      case "captureStopped":
        // Terminal ack — the process exit finishes teardown; nothing else here.
        return;
      case "error":
        this.onHelperError(msg.code, msg.message);
        return;
      default:
        return;
    }
  }

  private onFrame(pcmBase64: string | undefined, level: number | undefined): void {
    if (this.state !== "capturing") return;
    // Level meter: throttled to ~10 Hz; report 0 while muted.
    this.maybeSendLevel(this.muted ? 0 : clamp01(level));
    if (this.muted) return; // muted -> drop the audio entirely.
    if (!pcmBase64 || !this.meetingId) return;
    let pcm: Uint8Array;
    try {
      pcm = base64ToBytes(pcmBase64);
    } catch {
      return; // bad payload -> drop, never forward.
    }
    if (pcm.byteLength === 0) return;
    const frame = encodeAudioFrame(
      { source: "system", seq: this.seq++, timestampMs: this.deps.now() - this.t0 },
      pcm,
    );
    // Copy into a standalone ArrayBuffer (the orchestrator expects an ArrayBuffer
    // it can own; the encoded view's buffer is exactly frame length here, but a
    // slice keeps ownership unambiguous and mirrors the renderer's transfer).
    const ab = frame.buffer.slice(
      frame.byteOffset,
      frame.byteOffset + frame.byteLength,
    ) as ArrayBuffer;
    this.deps.enqueueFrame({ meetingId: this.meetingId, source: "system", frame: ab });
  }

  private maybeSendLevel(level: number): void {
    if (!this.meetingId) return;
    const now = this.deps.now();
    if (now - this.lastLevelAt < LEVEL_THROTTLE_MS) return;
    this.lastLevelAt = now;
    this.deps.sendLevel(this.meetingId, level);
  }

  private onHelperError(code: string | undefined, message: string | undefined): void {
    const errCode = normalizeErrorCode(code);
    this.deps.log(`helper error (${errCode}): ${message ?? "(no message)"}`);
    if (this.state === "starting") {
      this.settleReady({ ok: false, code: errCode, message: message ?? errCode });
    }
    this.hardStop("failed");
  }

  private onExit(code: number | null, signal: string | null): void {
    const wasActive = this.state === "starting" || this.state === "capturing";
    if (this.state === "starting") {
      // Exited before ever becoming ready.
      this.settleReady({
        ok: false,
        code: "capture_failed",
        message: `capture helper exited before ready (code=${code}, signal=${signal})`,
      });
    } else if (wasActive) {
      this.deps.log(`capture helper exited unexpectedly (code=${code}, signal=${signal})`);
    }
    this.finalize(wasActive ? "failed" : "idle");
  }

  private settleReady(result: NativeCaptureStartResult): void {
    if (this.readyTimer) {
      this.deps.clearTimer(this.readyTimer);
      this.readyTimer = null;
    }
    const resolve = this.readyResolve;
    this.readyResolve = null;
    resolve?.(result);
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.deps.log(`failed to write to helper stdin: ${errMsg(err)}`);
    }
  }

  /** Force-kill the child and reset. `finalState` defaults to "idle". */
  private hardStop(finalState: NativeCaptureState = "idle"): void {
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.finalize(finalState);
  }

  /** Clear timers + child handle and settle any pending start. */
  private finalize(finalState: NativeCaptureState): void {
    if (this.readyTimer) {
      this.deps.clearTimer(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.stopTimer) {
      this.deps.clearTimer(this.stopTimer);
      this.stopTimer = null;
    }
    // If a start is still pending (e.g. failed before ready), settle it.
    if (this.readyResolve) {
      this.settleReady({
        ok: false,
        code: finalState === "failed" ? "capture_failed" : "capture_unavailable",
        message: "capture ended before ready",
      });
    }
    this.child = null;
    this.state = finalState === "capturing" ? "idle" : finalState;
    if (this.state !== "failed") this.meetingId = null;
  }
}

/** Clamp a possibly-undefined number into [0, 1]; undefined/NaN -> 0. */
function clamp01(v: number | undefined): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Decode a base64 string to bytes (Node Buffer). Throws on invalid input length. */
function base64ToBytes(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function normalizeErrorCode(code: string | undefined): NativeCaptureErrorCode {
  if (code === "capture_unavailable" || code === "capture_denied" || code === "capture_failed") {
    return code;
  }
  return "capture_failed";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default {@link ChildLike} adapter over Node's `child_process.spawn`. Spawns the
 * helper in capture mode and adapts stdout into `"line"` events (splitting on
 * `\n`, buffering partial lines across chunks). Kept out of the class so the
 * class stays Node-free and fully fake-able in tests.
 *
 * @param captureArg the CLI arg that puts the helper into capture mode
 *   (defaults to `"capture"` — adjust to match the PART-1 helper's flag).
 */
export function makeDefaultSpawn(
  captureArg = "capture",
): (bin: string) => ChildLike {
  return (bin: string): ChildLike => {
    // The class itself never imports this (tests inject a fake ChildLike), so the
    // Node child_process dependency stays isolated to the production spawn path.
    const proc = nodeSpawn(bin, [captureArg], { stdio: ["pipe", "pipe", "pipe"] });

    const lineHandlers = new Set<(line: string) => void>();
    let buf = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        for (const h of lineHandlers) h(line);
      }
    });
    // Surface helper stderr as debug noise, not frames.
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      console.error("[loqui][native-capture][helper]", chunk.trimEnd());
    });

    return {
      stdin: {
        write: (data: string): void => {
          proc.stdin?.write(data);
        },
      },
      stdout: {
        on: (_event: "line", cb: (line: string) => void): void => {
          lineHandlers.add(cb);
        },
      },
      on: (_event: "exit", cb: (code: number | null, signal: string | null) => void): void => {
        proc.on("exit", cb);
      },
      kill: (signal?: NodeJS.Signals | number): void => {
        proc.kill(signal);
      },
    };
  };
}

/**
 * The `system` source byte the encoded frames carry — re-exported so callers /
 * tests can assert the source without re-importing the shared codec constant.
 */
export const NATIVE_SYSTEM_SOURCE_BYTE = AUDIO_FRAME_SOURCE.system;

/**
 * Resolve the capture helper binary — the SAME resolution main uses for
 * `LOQUI_ASR_HELPER_BIN` (see main/index.ts). Packaged:
 * `<resourcesDir>/native/loqui-asr-helper`; dev:
 * `<resourcesDir>/apps/desktop/native/macos/.build/release/loqui-asr-helper`.
 * Returns null when the helper isn't present so `start` fails cleanly with
 * `capture_unavailable`. Takes the resolved pieces (not `AppPaths`) so it is
 * unit-testable without Electron.
 *
 * @param resourcesDir the dir bundled resources live in (AppPaths.resourcesDir()).
 * @param isPackaged   whether running from a packaged app (AppPaths.isPackaged).
 * @param fileExists   existence check (defaults to fs.existsSync; injected for tests).
 */
export function resolveNativeCaptureHelperBin(
  resourcesDir: string,
  isPackaged: boolean,
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  const helper = isPackaged
    ? join(resourcesDir, "native", "loqui-asr-helper")
    : join(resourcesDir, "apps", "desktop", "native", "macos", ".build", "release", "loqui-asr-helper");
  return fileExists(helper) ? helper : null;
}
