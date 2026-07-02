/**
 * Dual-stream capture controller (PRD-1, renderer side).
 *
 * Owns the browser-side capture pipeline for ONE meeting and BOTH sources
 * (mic = "You", system = "They"), kept rigorously INDEPENDENT: each source has
 * its own MediaStream, AudioContext, worklet node, analyser, level state and
 * sequence of binary frames. Nothing is ever mixed.
 *
 * Per source, start():
 *   1. asks main to begin the stream  → window.loqui.audio.startCapture()
 *      (main sets the active meeting + emits the `audioStart` control frame).
 *      Its result carries a `mode`: "renderer" (default) or "native".
 *   2. RENDERER mode acquires the device stream:
 *        mic    → navigator.mediaDevices.getUserMedia({ audio })
 *        system → navigator.mediaDevices.getDisplayMedia({ audio, video })  —
 *                 WINDOWS-ONLY loopback; keeps ONLY the audio track,
 *   3. builds an AudioContext, loads the @loqui/audio worklet module, creates a
 *      `loqui-capture` AudioWorkletNode tagged with the source, and routes each
 *      posted binary frame ArrayBuffer to window.loqui.audio.sendFrame(),
 *   4. taps an AnalyserNode for an independent, renderer-side level meter.
 *
 * NATIVE mode (macOS system audio via ScreenCaptureKit in the Swift helper):
 * MAIN owns capture and is already pumping frames to the sidecar, so the
 * renderer skips ALL stream/AudioContext/worklet work — it only mirrors main's
 * ~10 Hz level pushes (window.loqui.audio.onSystemLevel) and forwards mute
 * intent (window.loqui.audio.setSystemMuted). Electron's loopback audio is
 * Windows-only, which is why macOS system audio must be captured natively.
 *
 * stop() tears the source down completely (worklet port closed, nodes
 * disconnected, tracks stopped, AudioContext closed, RAF cancelled) and asks
 * main to stop the stream (`audioStop`). start→stop→start leaks nothing.
 *
 * Everything that touches the DOM/Web-Audio is injectable so the controller is
 * unit-testable without a real microphone (see controller.test.ts). jsdom has
 * no getUserMedia/AudioWorklet, so the production path is manual-verified via
 * `pnpm dev`; the tests cover orchestration/teardown with fakes.
 */
import type { AudioSource, CaptureMode, LoquiAudioApi } from "@loqui/shared";

/** Registered AudioWorklet processor name in @loqui/audio. */
export const CAPTURE_PROCESSOR_NAME = "loqui-capture";

/**
 * The audio-bridge seam the controller codes against — the shared
 * {@link LoquiAudioApi} (`window.loqui.audio`). PART 2 grew it with the
 * native-mode surface (`onSystemLevel` / `setSystemMuted`) and taught
 * `startCapture` to report a {@link CaptureMode}; the controller consumes those
 * here. Aliased (not re-declared) so tests can inject a structural fake and so
 * this file has a single named seam to reason about.
 *
 * Capture ownership per the `startCapture` result's `mode`:
 * - `"renderer"` (default / undefined): the RENDERER owns capture for this
 *   source — getUserMedia (mic) or getDisplayMedia loopback (Windows system
 *   audio). This is the original path and stays byte-for-byte unchanged.
 * - `"native"`: MAIN owns capture (macOS system audio via ScreenCaptureKit in
 *   the Swift helper). Main is already pumping PCM frames to the sidecar, so the
 *   renderer must NOT touch getDisplayMedia / Web-Audio; it only mirrors
 *   main-pushed level updates and forwards mute intent.
 */
export type CaptureAudioBridge = LoquiAudioApi;

/** Per-source lifecycle state surfaced to the UI. */
export type CaptureSourceState = "idle" | "starting" | "capturing" | "stopping" | "error";

/** A snapshot of one source's status for the UI. */
export interface CaptureStatus {
  state: CaptureSourceState;
  /** Linear peak level in [0, 1] for the meter (0 when not capturing). */
  level: number;
  /**
   * Whether this source is MUTED (PRD-13). While muted, the controller stops
   * forwarding that source's PCM frames to main (so the muted side is NOT
   * transcribed/recorded) and reports level 0. mic and system mute
   * INDEPENDENTLY — muting one never touches the other (the two-streams-separate
   * invariant). Optional + defaults false (additive — older status snapshots
   * without the field read as unmuted); toggling does not stop/restart the
   * stream.
   */
  muted?: boolean;
  /** Populated when `state === "error"`. */
  error?: string;
}

export type CaptureStatusListener = (source: AudioSource, status: CaptureStatus) => void;

/**
 * Minimal Web-Audio / media surface the controller depends on. Injected so the
 * orchestration is testable; defaults bind to the real browser globals.
 */
export interface CaptureEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Factory for an AudioContext locked to the given sample rate. */
  createAudioContext(): AudioContext;
  /**
   * Construct the capture worklet node on a context. Injected so tests need no
   * real AudioWorkletNode (absent in jsdom).
   */
  createWorkletNode(context: AudioContext, source: AudioSource): AudioWorkletNode;
  /** Resolves the URL of the worklet module to addModule(). */
  workletModuleUrl(): string | URL;
  /** rAF used to poll the analyser; injectable for tests. */
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

export interface CaptureControllerDeps {
  /** The window.loqui.audio bridge (injected for tests). */
  audio: CaptureAudioBridge;
  meetingId: string;
  /** Web-Audio/media surface; defaults to the real browser globals. */
  env?: Partial<CaptureEnv>;
  onStatus?: CaptureStatusListener;
  /** Mic device id from the picker (undefined = system default). */
  micDeviceId?: string;
}

/** Default audio constraints per source. */
function micConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

/**
 * getDisplayMedia constraints for RENDERER-mode system capture. Electron's
 * loopback audio (`audio: "loopback"` / the display-media loopback track) is
 * WINDOWS-ONLY, so this path only ever runs on Windows; on macOS main captures
 * system audio natively (mode:"native") and this branch is skipped entirely.
 * getDisplayMedia requires a video constraint to be offered even when we only
 * want the loopback audio track (it rides the display-media request), so we
 * offer a tiny video track and keep only the audio one for capture.
 */
const SYSTEM_CONSTRAINTS: MediaStreamConstraints = {
  audio: true,
  video: { width: 1, height: 1, frameRate: 1 },
};

function defaultEnv(): CaptureEnv {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    getDisplayMedia: (c) => navigator.mediaDevices.getDisplayMedia(c),
    createAudioContext: () =>
      new AudioContext({ sampleRate: 16000, latencyHint: "interactive" }),
    createWorkletNode: (context, source) =>
      new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { source, startTimeMs: 0 },
      }),
    // The worklet is pre-bundled (esbuild, scripts/build-worklet.mjs) into the
    // renderer's public/ as a SELF-CONTAINED script, served at the web root in
    // dev and copied next to index.html on build — so resolving it against
    // document.baseURI works in both. (Loading it relative to import.meta.url —
    // i.e. the hashed assets/ bundle — 404'd, which made addModule throw
    // AbortError "The user aborted a request.")
    workletModuleUrl: () => new URL("capture-worklet.js", document.baseURI),
    requestAnimationFrame: (cb) => requestAnimationFrame(cb),
    cancelAnimationFrame: (h) => cancelAnimationFrame(h),
  };
}

/**
 * Internal per-source resources, all owned so teardown is total. A discriminated
 * union on `mode`: renderer-mode owns the full Web-Audio graph; native-mode owns
 * only a subscription to main-pushed level updates (main runs the real capture).
 */
type SourceResources =
  | {
      mode: "renderer";
      stream: MediaStream;
      context: AudioContext;
      sourceNode: MediaStreamAudioSourceNode;
      workletNode: AudioWorkletNode;
      analyser: AnalyserNode;
      rafHandle: number | null;
      /** Reused scratch buffer for analyser reads (typed for the DOM overload). */
      meterBuf: Float32Array<ArrayBuffer>;
    }
  | {
      mode: "native";
      /** Unsubscribe from main's level pushes (null if the bridge lacks the hook). */
      unsubscribeLevel: (() => void) | null;
    };

export interface CaptureController {
  /** Begin capturing one source. Idempotent: re-entry while active is a no-op. */
  start(source: AudioSource): Promise<void>;
  /** Stop one source and release ALL of its resources. */
  stop(source: AudioSource): Promise<void>;
  /** Stop every active source (used on unmount / meeting end). */
  stopAll(): Promise<void>;
  /** Current status snapshot for a source. */
  getStatus(source: AudioSource): CaptureStatus;
  /**
   * Mute/unmute ONE source (PRD-13). While muted the controller stops forwarding
   * that source's frames to main and reports level 0; the other source is
   * untouched. Idempotent.
   */
  setMuted(source: AudioSource, muted: boolean): void;
  /** Toggle mute for one source; returns the new muted state. */
  toggleMute(source: AudioSource): boolean;
  /** Subscribe to status changes; returns an unsubscribe fn. */
  subscribe(listener: CaptureStatusListener): () => void;
}

export function createCaptureController(deps: CaptureControllerDeps): CaptureController {
  const env: CaptureEnv = { ...defaultEnv(), ...deps.env };
  const { audio, meetingId } = deps;

  const statuses: Record<AudioSource, CaptureStatus> = {
    mic: { state: "idle", level: 0, muted: false },
    system: { state: "idle", level: 0, muted: false },
  };
  const resources: Partial<Record<AudioSource, SourceResources>> = {};
  const listeners = new Set<CaptureStatusListener>();
  if (deps.onStatus) listeners.add(deps.onStatus);

  function setStatus(source: AudioSource, patch: Partial<CaptureStatus>): void {
    statuses[source] = { ...statuses[source], ...patch };
    const snapshot = statuses[source];
    for (const l of listeners) l(source, snapshot);
  }

  async function start(source: AudioSource): Promise<void> {
    const current = statuses[source].state;
    if (current === "starting" || current === "capturing") return;
    setStatus(source, { state: "starting", level: 0, error: undefined });

    // 1) Tell main to begin (active meeting + audioStart control frame). If
    //    main refuses (e.g. screen permission denied for system), surface it.
    let begun = false;
    try {
      const res = await audio.startCapture({ meetingId, source });
      if (!res.ok) {
        setStatus(source, {
          state: "error",
          error: res.message ?? res.code ?? "capture start refused",
        });
        return;
      }
      begun = true;

      // PART 2 may report that MAIN owns this source's capture (macOS system
      // audio via ScreenCaptureKit). Omitted / "renderer" = the renderer path.
      const mode: CaptureMode = res.mode === "native" ? "native" : "renderer";

      if (mode === "native") {
        // Main is already pumping frames to the sidecar. The renderer must NOT
        // touch getDisplayMedia / Web-Audio for this source; it only mirrors the
        // level meter from main's ~10 Hz pushes and forwards mute intent.
        const unsubscribeLevel =
          audio.onSystemLevel?.((payload) => {
            if (payload.meetingId !== meetingId) return; // filter to our meeting
            // A muted source reads 0 on the meter (main also drops its frames).
            const level = statuses[source].muted ? 0 : payload.level;
            if (statuses[source].state === "capturing" && statuses[source].level !== level) {
              setStatus(source, { level });
            }
          }) ?? null;
        resources[source] = { mode: "native", unsubscribeLevel };
        setStatus(source, { state: "capturing", level: 0, error: undefined });
        return;
      }

      // 2) Acquire the device stream (RENDERER mode: mic everywhere, plus
      //    Windows loopback system audio — the only place getDisplayMedia runs).
      let stream: MediaStream;
      if (source === "mic") {
        stream = await env.getUserMedia(micConstraints(deps.micDeviceId));
      } else {
        const display = await env.getDisplayMedia(SYSTEM_CONSTRAINTS);
        // Windows loopback: the audio track rides the SAME display-media session
        // as the VIDEO track. Stopping/removing the video track tears down that
        // session, which silences the audio track — the worklet then never sees
        // a sample and `system.wav` stays a 44-byte empty header. So KEEP the
        // video track for the lifetime of the capture; just disable it so no
        // frames are pulled/encoded. It is ignored by createMediaStreamSource
        // (audio-only) and is stopped on teardown by releaseResources (which
        // stops ALL stream tracks). (On macOS this branch never runs — main
        // captures system audio natively; see SYSTEM_CONSTRAINTS.)
        for (const track of display.getVideoTracks()) {
          track.enabled = false;
        }
        if (display.getAudioTracks().length === 0) {
          throw new Error("no system-audio track in the display-media stream");
        }
        stream = display;
      }

      // 3) Build the per-source audio graph and load the worklet.
      const context = env.createAudioContext();
      await context.audioWorklet.addModule(env.workletModuleUrl());
      // A fresh AudioContext can start suspended; a MediaStream source only pulls
      // when the context is running. Resume defensively (no-op if already running).
      try {
        await context.resume();
      } catch {
        /* ignore */
      }
      const sourceNode = context.createMediaStreamSource(stream);
      const workletNode = env.createWorkletNode(context, source);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;

      // Route the encoded binary frames straight to main (fire-and-forget).
      // PRD-13: while this source is muted, DROP its frames (so the muted side is
      // not transcribed/recorded). The other source is unaffected.
      workletNode.port.onmessage = (event: MessageEvent): void => {
        if (statuses[source].muted) return;
        const frame = event.data as ArrayBuffer;
        if (frame instanceof ArrayBuffer && frame.byteLength > 0) {
          audio.sendFrame({ meetingId, source, frame });
        }
      };

      // Tap: sourceNode → analyser (for the meter) and → worklet (for frames).
      // The analyser branch never feeds an output, so nothing is audible.
      sourceNode.connect(analyser);
      sourceNode.connect(workletNode);

      const meterBuf = new Float32Array(
        new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
      );
      const res2: SourceResources = {
        mode: "renderer",
        stream,
        context,
        sourceNode,
        workletNode,
        analyser,
        rafHandle: null,
        meterBuf,
      };
      resources[source] = res2;
      startMeter(source, res2);

      // If a track ends on its own (user revokes the share / unplugs mic),
      // tear that source down so the UI reflects reality.
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          void stop(source);
        });
      }

      setStatus(source, { state: "capturing", level: 0, error: undefined });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      // System audio needs Screen Recording permission on macOS. Two ways it can
      // surface a refusal: (a) native mode — main's startCapture returns
      // `ok:false` (handled above, not here); (b) Windows renderer-mode loopback
      // rides a getDisplayMedia request, which without permission rejects with a
      // cryptic AbortError ("The user aborted a request." / "Error starting
      // capture"). Translate that into an actionable message instead — the mic
      // ("You") stream is unaffected and keeps recording.
      const needsScreenPermission =
        source === "system" &&
        (name === "AbortError" ||
          name === "NotAllowedError" ||
          name === "SecurityError" ||
          /abort|starting capture|not allowed|permission|denied/i.test(raw));
      const message = needsScreenPermission
        ? "Can’t capture system audio yet — macOS needs Screen Recording permission. " +
          "Open System Settings → Privacy & Security → Screen Recording, enable Loqui, then restart. " +
          "Your microphone is still being recorded."
        : raw;
      // Best-effort: if we already told main to start, tell it to stop.
      if (begun) {
        try {
          await audio.stopCapture({ meetingId, source });
        } catch {
          /* ignore teardown error */
        }
      }
      await releaseResources(source);
      setStatus(source, { state: "error", level: 0, error: message });
    }
  }

  function startMeter(source: AudioSource, res: SourceResources & { mode: "renderer" }): void {
    const tick = (): void => {
      const cur = resources[source];
      if (!cur || cur !== res) return; // stopped/replaced
      res.analyser.getFloatTimeDomainData(res.meterBuf);
      let peak = 0;
      // A muted source reads 0 on the meter (it isn't being captured/forwarded).
      if (!statuses[source].muted) {
        for (let i = 0; i < res.meterBuf.length; i += 1) {
          const a = Math.abs(res.meterBuf[i]!);
          if (a > peak) peak = a;
        }
      }
      if (statuses[source].state === "capturing" && statuses[source].level !== peak) {
        setStatus(source, { level: peak });
      }
      res.rafHandle = env.requestAnimationFrame(tick);
    };
    res.rafHandle = env.requestAnimationFrame(tick);
  }

  /** Release every resource for a source WITHOUT touching main (idempotent). */
  async function releaseResources(source: AudioSource): Promise<void> {
    const res = resources[source];
    if (!res) return;
    delete resources[source]; // detach first so the meter tick bails out.

    if (res.mode === "native") {
      // Native mode owns only the main-pushed level subscription.
      try {
        res.unsubscribeLevel?.();
      } catch {
        /* ignore */
      }
      return;
    }

    if (res.rafHandle !== null) env.cancelAnimationFrame(res.rafHandle);
    try {
      res.workletNode.port.onmessage = null;
      res.workletNode.port.close();
    } catch {
      /* ignore */
    }
    try {
      res.sourceNode.disconnect();
    } catch {
      /* ignore */
    }
    try {
      res.workletNode.disconnect();
    } catch {
      /* ignore */
    }
    try {
      res.analyser.disconnect();
    } catch {
      /* ignore */
    }
    for (const track of res.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      await res.context.close();
    } catch {
      /* ignore */
    }
  }

  async function stop(source: AudioSource): Promise<void> {
    const state = statuses[source].state;
    if (state === "idle" || state === "stopping") return;
    setStatus(source, { state: "stopping", level: 0 });
    await releaseResources(source);
    try {
      await audio.stopCapture({ meetingId, source });
    } catch {
      /* best-effort; main also tolerates duplicate stops */
    }
    setStatus(source, { state: "idle", level: 0, muted: false, error: undefined });
  }

  async function stopAll(): Promise<void> {
    await Promise.all([stop("mic"), stop("system")]);
  }

  function setMuted(source: AudioSource, muted: boolean): void {
    if (statuses[source].muted === muted) return;
    // Mute drops frames immediately and zeroes the meter; unmute resumes both.
    setStatus(source, { muted, level: muted ? 0 : statuses[source].level });
    // Native mode: the frames live in MAIN, so also tell main to drop/resume
    // them (renderer-mode drops locally in the worklet onmessage handler).
    const res = resources[source];
    if (res?.mode === "native") {
      void audio.setSystemMuted?.({ meetingId, muted })?.catch(() => {
        /* fire-and-forget */
      });
    }
  }

  function toggleMute(source: AudioSource): boolean {
    const next = !statuses[source].muted;
    setMuted(source, next);
    return next;
  }

  return {
    start,
    stop,
    stopAll,
    getStatus: (source) => statuses[source],
    setMuted,
    toggleMute,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
