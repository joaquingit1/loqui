/**
 * AudioWorklet processor: the trivial browser-side SHELL of the capture DSP.
 *
 * This file is intentionally a thin shim — it contains NO algorithmic logic so
 * that everything testable lives in the pure modules (`downmix`, `resample`,
 * `pcm`, `frame-codec`), which run under Node/vitest with synthetic buffers.
 * There is no `AudioWorklet` in jsdom, so this file is NOT unit-tested; it is
 * loaded into an `AudioWorkletGlobalScope` at runtime via
 * `audioContext.audioWorklet.addModule(...)`.
 *
 * Per render quantum, for ONE source (mic or system — the two streams run as
 * two independent worklet nodes and are NEVER mixed), it:
 *   1. downmixes the input channels to mono,
 *   2. feeds the mono block to a STATEFUL {@link StreamingResampler} that
 *      retains the previous quantum's tail + a fractional output-position
 *      accumulator, so the 16 kHz output is correctly anti-aliased across block
 *      boundaries and the long-run rate is exactly 16 kHz (no per-quantum
 *      zero-pad corruption, no 0.78% clock skew — see resample.ts),
 *   3. accumulates the emitted 16 kHz samples into a mono buffer,
 *   4. once at least `frameSamples` are buffered, slices a frame, converts it
 *      to pcm_s16le, encodes the binary wire frame, and posts it to the main
 *      thread over the worklet `port` (transferring the ArrayBuffer).
 *
 * Each frame's head timestamp is derived from the CUMULATIVE count of emitted
 * 16 kHz samples (`startTimeMs + emittedSamples/16000 * 1000`); because the
 * streaming resampler no longer rounds per block, this stays locked to the real
 * sample clock and the two independent streams stay aligned over a long meeting.
 *
 * The node is constructed with `processorOptions`:
 *   { source: "mic" | "system", frameSamples?: number, startTimeMs?: number }
 *
 * The main/renderer side hands the posted `ArrayBuffer` to
 * `window.loqui.audio.sendFrame({ meetingId, source, frame })`.
 */
import {
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
  type AudioSource,
} from "@loqui/shared";
import { downmixToMono } from "./downmix.js";
import { StreamingResampler } from "./resample.js";
import { floatToPcm16 } from "./pcm.js";
import { encodeFrame } from "./frame-codec.js";

/** Options passed via `new AudioWorkletNode(ctx, name, { processorOptions })`. */
export interface CaptureProcessorOptions {
  /** which independent stream this node carries (mic = "You", system = "They") */
  source: AudioSource;
  /** target samples per emitted frame at 16 kHz (default AUDIO_FRAME_SAMPLES) */
  frameSamples?: number;
  /** ms-since-meeting-start corresponding to this node's first sample */
  startTimeMs?: number;
}

/** Registered name for `audioWorklet.addModule` consumers. */
export const CAPTURE_PROCESSOR_NAME = "loqui-capture";

// ---------------------------------------------------------------------------
// AudioWorklet ambient API.
//
// The `AudioWorkletGlobalScope` symbols (`AudioWorkletProcessor`,
// `registerProcessor`, `sampleRate`, `currentTime`) are NOT part of TypeScript's
// shipped `lib.dom.d.ts` — they live only inside a real worklet global scope at
// runtime. We declare just the slice we use so this shell typechecks under the
// package's `tsconfig`. NONE of this runs under Node/jsdom, so it is untested.
// ---------------------------------------------------------------------------
interface AudioWorkletMessagePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((this: AudioWorkletMessagePort, ev: MessageEvent) => unknown) | null;
}

declare class AudioWorkletProcessor {
  readonly port: AudioWorkletMessagePort;
  constructor(options?: unknown);
}

declare const registerProcessor: (
  name: string,
  // The runtime accepts any AudioWorkletProcessor subclass constructor; the
  // exact constructor-option shape varies per processor, so it is left open.
  ctor: new (...args: never[]) => AudioWorkletProcessor,
) => void;

/** The worklet global scope's input/output sample rate (Hz). */
declare const sampleRate: number;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly source: AudioSource;
  private readonly frameSamples: number;
  /** stateful 16 kHz resampler carrying history + fractional output phase */
  private readonly resampler: StreamingResampler;
  /** ms-since-meeting-start of this node's first emitted 16 kHz sample */
  private readonly startTimeMs: number;
  /** ring of resampled 16 kHz mono samples awaiting framing */
  private pending: Float32Array;
  private pendingLen = 0;
  /** per-source monotonic frame sequence number */
  private seq = 0;
  /**
   * Total 16 kHz samples emitted to frames so far. Drives a drift-free head
   * timestamp (no per-block rounding upstream), so mic + system stay aligned.
   */
  private emittedSamples = 0;

  constructor(options?: { processorOptions?: CaptureProcessorOptions }) {
    super();
    const opts = options?.processorOptions;
    this.source = opts?.source ?? "mic";
    this.frameSamples = opts?.frameSamples ?? AUDIO_FRAME_SAMPLES;
    this.startTimeMs = opts?.startTimeMs ?? 0;
    this.resampler = new StreamingResampler(sampleRate, AUDIO_SAMPLE_RATE);
    // Generous initial capacity; grown if a quantum overshoots.
    this.pending = new Float32Array(this.frameSamples * 4);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    // No connected input this quantum: keep the processor alive.
    if (!input || input.length === 0) {
      return true;
    }
    const mono = downmixToMono(input);
    // Streaming resample: carries the previous quantum's tail + fractional
    // output phase so each block is correctly anti-aliased (no zero-pad
    // corruption) and the output rate is exactly 16 kHz (no clock skew).
    const at16k = this.resampler.process(mono);

    this.append(at16k);
    this.drainFrames();
    return true;
  }

  /** Append resampled samples, growing the buffer if needed. */
  private append(samples: Float32Array): void {
    const need = this.pendingLen + samples.length;
    if (need > this.pending.length) {
      const grown = new Float32Array(Math.max(need, this.pending.length * 2));
      grown.set(this.pending.subarray(0, this.pendingLen));
      this.pending = grown;
    }
    this.pending.set(samples, this.pendingLen);
    this.pendingLen += samples.length;
  }

  /** Emit as many full frames as are buffered. */
  private drainFrames(): void {
    const msPerSample = 1000 / AUDIO_SAMPLE_RATE;
    while (this.pendingLen >= this.frameSamples) {
      const slice = this.pending.subarray(0, this.frameSamples);
      const pcm = floatToPcm16(slice);
      // Head timestamp from the cumulative emitted-sample count, NOT a per-frame
      // running add: exact 16 kHz output means emittedSamples/16000 is the true
      // elapsed time of this frame's first sample (drift-free cross-stream).
      const headTimeMs = this.startTimeMs + this.emittedSamples * msPerSample;
      const frame = encodeFrame(this.source, this.seq, headTimeMs, pcm);
      // Post + transfer the underlying buffer to avoid a copy on the IPC hop.
      this.port.postMessage(frame.buffer, [frame.buffer]);

      this.seq = (this.seq + 1) >>> 0;
      this.emittedSamples += this.frameSamples;
      // Shift the remaining tail down.
      const rest = this.pendingLen - this.frameSamples;
      this.pending.copyWithin(0, this.frameSamples, this.pendingLen);
      this.pendingLen = rest;
    }
  }
}

// Register only inside a real AudioWorkletGlobalScope.
if (typeof registerProcessor === "function") {
  registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor);
}

export { CaptureProcessor };
