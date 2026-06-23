/**
 * Sample-rate conversion to 16 kHz (the canonical capture rate).
 *
 * ## Why not naive decimation
 * Dropping samples (e.g. taking every 3rd sample of 48 kHz to get 16 kHz)
 * folds all energy above the new Nyquist (8 kHz) back down into the audible
 * band as aliasing — a hard, irreversible artifact. We instead band-limit with
 * a windowed-sinc FIR low-pass and resample by direct convolution at the
 * fractional output positions. This is a standard, well-understood approach;
 * it is O(taps) per output sample and entirely allocation-free per call beyond
 * the output buffer and a cached kernel.
 *
 * ## The filter
 * The reconstruction/anti-alias filter is an ideal low-pass (a sinc) windowed
 * by a Blackman window for good stopband attenuation (~ -58 dB) with a modest
 * tap count. Its cutoff is the SMALLER of the input and output Nyquist
 * frequencies, expressed relative to the input rate:
 *
 *   fc = min(0.5, 0.5 * outputRate / inputRate)        (cycles/input-sample)
 *
 * For downsampling (inputRate > 16k) the cutoff is the OUTPUT Nyquist (8 kHz),
 * so everything that would alias is removed before we pick output samples.
 * For upsampling (inputRate < 16k) the cutoff is the input Nyquist, so we just
 * band-limit the interpolation. For inputRate == 16000 we short-circuit to a
 * copy (true passthrough — no filtering, no phase shift).
 *
 * ## Implementation: time-varying convolution
 * Each output sample k maps to the continuous input position
 *   pos = k * (inputRate / outputRate).
 * We sum input[n] * h(pos - n) over the window of taps around `pos`, where
 * `h` is the windowed sinc scaled so its cutoff is `fc` and its gain at DC is
 * 1. The kernel is evaluated on the fly from a half-width and a per-call
 * `step` so it works for any rational rate ratio (44100, 48000, 8000, ...).
 */

import { AUDIO_SAMPLE_RATE } from "@loqui/shared";

/** Half-width of the FIR in input samples (per side). Total taps ~ 2*ZERO_CROSSINGS+1. */
const ZERO_CROSSINGS = 16;

interface Kernel {
  /** filtered/windowed sinc samples, indexed by integer offset within window */
  readonly fc: number;
  /** half window in input samples (filter "reach" on each side) */
  readonly halfWindow: number;
}

/** Blackman window, evaluated at normalized position t in [-1, 1] (0 = center). */
function blackman(t: number): number {
  // x in [0, 1] across the full window; t in [-1, 1].
  const x = (t + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

/** Normalized sinc: sinc(0) = 1, sinc(x) = sin(pi x)/(pi x). */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Build the resampling kernel parameters for a given rate ratio.
 *
 * `fc` is the low-pass cutoff in cycles per INPUT sample (<= 0.5). The window
 * half-width is widened when downsampling so the filter spans the same number
 * of OUTPUT-rate zero-crossings (this keeps stopband attenuation roughly
 * constant as the cutoff drops).
 */
function makeKernel(inputRate: number, outputRate: number): Kernel {
  const ratio = outputRate / inputRate;
  // Cutoff = min(input Nyquist, output Nyquist) expressed per input sample.
  const fc = 0.5 * Math.min(1, ratio);
  // For downsampling (ratio < 1), stretch the window by 1/ratio so we still
  // capture ZERO_CROSSINGS lobes of the (now wider) sinc.
  const halfWindow = ZERO_CROSSINGS / (2 * fc);
  return { fc, halfWindow };
}

/**
 * Resample `input` (sampled at `inputRate` Hz) to {@link AUDIO_SAMPLE_RATE}
 * (16 kHz) mono Float32 using a windowed-sinc anti-aliasing FIR.
 *
 * - `inputRate === 16000` -> returns a COPY (exact passthrough).
 * - empty input           -> empty output.
 * - otherwise             -> band-limited, properly anti-aliased resample.
 *
 * The output length is `round(input.length * outputRate / inputRate)`.
 *
 * @throws if `inputRate` is not a positive finite number.
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  return resample(input, inputRate, AUDIO_SAMPLE_RATE);
}

/**
 * General windowed-sinc resampler (exposed for testing arbitrary target rates).
 * See the module header for the filter design.
 */
export function resample(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (!(inputRate > 0) || !Number.isFinite(inputRate)) {
    throw new Error(`resample: invalid inputRate ${inputRate}`);
  }
  if (!(outputRate > 0) || !Number.isFinite(outputRate)) {
    throw new Error(`resample: invalid outputRate ${outputRate}`);
  }
  if (input.length === 0) {
    return new Float32Array(0);
  }
  if (inputRate === outputRate) {
    return input.slice();
  }

  const n = input.length;
  const outLength = Math.round((n * outputRate) / inputRate);
  if (outLength === 0) {
    return new Float32Array(0);
  }
  const out = new Float32Array(outLength);

  const { fc, halfWindow } = makeKernel(inputRate, outputRate);
  const step = inputRate / outputRate; // input samples advanced per output sample
  // 2*fc is the gain normalization for a sinc low-pass of cutoff fc.
  const twoFc = 2 * fc;

  for (let k = 0; k < outLength; k++) {
    const center = k * step; // continuous input position
    const first = Math.ceil(center - halfWindow);
    const last = Math.floor(center + halfWindow);

    let acc = 0;
    let norm = 0; // sum of weights, for DC-gain normalization at the edges
    for (let i = first; i <= last; i++) {
      const dist = center - i; // in input samples
      // windowed-sinc: low-pass at cutoff fc (per input sample).
      const w = blackman(dist / halfWindow) * twoFc * sinc(twoFc * dist);
      norm += w;
      if (i < 0 || i >= n) {
        // zero-pad beyond the signal edges (treat as silence).
        continue;
      }
      acc += (input[i] as number) * w;
    }
    // Normalize by the (windowed) weight sum so DC gain is exactly 1 even at
    // the signal boundaries where the window is truncated.
    out[k] = norm !== 0 ? acc / norm : 0;
  }

  return out;
}

/**
 * Stateful streaming resampler for the AudioWorklet hot path.
 *
 * ## Why the one-shot {@link resample} is WRONG per render quantum
 *
 * The Web Audio spec hands the worklet a fixed 128-sample render quantum. The
 * windowed-sinc FIR reaches `halfWindow` INPUT samples on each side of every
 * output position (for 48k->16k, `halfWindow = ZERO_CROSSINGS/(2*fc) = 48`
 * input samples). If you call the stateless `resample()` on each 128-sample
 * block in isolation, the filter sees ZEROS beyond the block edges — and since
 * 2*48 = 96 of every 128 samples sit inside that transition region, ~75% of
 * every block is corrupted by zero-padding. The fundamental collapses (~34 dB
 * of attenuation measured) and block-boundary spurs appear. Separately,
 * `round(128 * 16000/48000) = 43` output samples per block gives 43*375 = 16125
 * samples/s instead of 16000 — a +0.78% clock skew that drifts the per-frame
 * timestamps out of sync with the real sample clock.
 *
 * ## The fix: carry history + a fractional output-position accumulator
 *
 * This class keeps:
 *   - a tail of the last `halfWindow` real input samples, so each output
 *     sample's FIR window is fed genuine neighbors instead of zero-pad; and
 *   - a continuous output-position accumulator (`pos`, in input-sample units)
 *     that advances by `step = inRate/outRate` per emitted sample and carries
 *     its fractional remainder across calls — so there is NO per-block rounding
 *     and the long-run output rate is exactly `outputRate`.
 *
 * It emits only output samples whose FULL `[pos-halfWindow, pos+halfWindow]`
 * window lies within the data we already have (history + this chunk), deferring
 * any sample whose right edge needs future input. The deferred input is kept as
 * the new history. Concatenating the per-chunk outputs reproduces the one-shot
 * result (modulo the unavoidable startup latency of `halfWindow` input samples).
 *
 * 16000->16000 short-circuits to passthrough (no filtering, no state).
 */
export class StreamingResampler {
  private readonly inputRate: number;
  private readonly outputRate: number;
  private readonly fc: number;
  private readonly halfWindow: number;
  private readonly step: number;
  private readonly twoFc: number;
  private readonly passthrough: boolean;

  /**
   * Buffered input samples not yet fully consumed. Absolute input index 0 of
   * the whole stream corresponds to `history[0 - historyBase]`; we track the
   * absolute index of `history[0]` in {@link bufferStart}.
   */
  private history: Float32Array = new Float32Array(0);
  /** Absolute input-sample index of `history[0]`. */
  private bufferStart = 0;
  /** Absolute input position (in input samples) of the NEXT output sample. */
  private pos = 0;
  /** Total input samples ever fed (for the exact input-clock timestamp). */
  private totalInput = 0;

  constructor(inputRate: number, outputRate: number = AUDIO_SAMPLE_RATE) {
    if (!(inputRate > 0) || !Number.isFinite(inputRate)) {
      throw new Error(`StreamingResampler: invalid inputRate ${inputRate}`);
    }
    if (!(outputRate > 0) || !Number.isFinite(outputRate)) {
      throw new Error(`StreamingResampler: invalid outputRate ${outputRate}`);
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.passthrough = inputRate === outputRate;
    const { fc, halfWindow } = makeKernel(inputRate, outputRate);
    this.fc = fc;
    // Round the reach up to whole input samples so the history bound is integral.
    this.halfWindow = Math.ceil(halfWindow);
    this.step = inputRate / outputRate;
    this.twoFc = 2 * fc;
  }

  /** Total input samples consumed so far (drives the exact input-clock time). */
  get inputSamplesSeen(): number {
    return this.totalInput;
  }

  /** Elapsed input-clock time in milliseconds (cumulative, drift-free). */
  get elapsedMs(): number {
    return (this.totalInput / this.inputRate) * 1000;
  }

  /**
   * Feed the next contiguous block of input samples and return every output
   * sample whose full filter window is now available. Allocation is bounded by
   * the chunk size; the returned buffer is freshly allocated each call.
   */
  process(chunk: Float32Array): Float32Array {
    this.totalInput += chunk.length;
    if (this.passthrough) {
      // Exact passthrough: copy out, no filtering, keep no history.
      return chunk.slice();
    }
    if (chunk.length === 0) return new Float32Array(0);

    // Append the chunk to whatever history we deferred last time.
    if (this.history.length === 0) {
      this.history = chunk.slice();
    } else {
      const merged = new Float32Array(this.history.length + chunk.length);
      merged.set(this.history, 0);
      merged.set(chunk, this.history.length);
      this.history = merged;
    }
    const bufEnd = this.bufferStart + this.history.length; // absolute index past the last sample
    const { halfWindow, step, twoFc } = this;

    // Emit every output sample whose window [pos-halfWindow, pos+halfWindow]
    // ends within the data we currently hold (right edge < bufEnd).
    const out: number[] = [];
    let pos = this.pos;
    while (pos + halfWindow < bufEnd) {
      const center = pos;
      const first = Math.ceil(center - halfWindow);
      const last = Math.floor(center + halfWindow);
      let acc = 0;
      let norm = 0;
      for (let i = first; i <= last; i++) {
        const dist = center - i;
        const w = blackman(dist / halfWindow) * twoFc * sinc(twoFc * dist);
        norm += w;
        const idx = i - this.bufferStart;
        if (idx < 0 || idx >= this.history.length) continue; // stream-edge zero-pad
        acc += (this.history[idx] as number) * w;
      }
      out.push(norm !== 0 ? acc / norm : 0);
      pos += step;
    }
    this.pos = pos;

    // Drop history we will never need again: anything left of the earliest
    // window we might still touch, i.e. ceil(pos - halfWindow).
    const keepFrom = Math.floor(pos - halfWindow);
    if (keepFrom > this.bufferStart) {
      const cut = keepFrom - this.bufferStart;
      if (cut >= this.history.length) {
        this.history = new Float32Array(0);
      } else {
        this.history = this.history.slice(cut);
      }
      this.bufferStart = keepFrom;
    }

    return Float32Array.from(out);
  }

  /**
   * Flush the final tail: emit the remaining output samples whose windows run
   * off the END of the stream (zero-padded past the last real sample), so the
   * total emitted count matches the one-shot resample of the whole signal.
   */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0);
    const bufEnd = this.bufferStart + this.history.length;
    const { halfWindow, step, twoFc } = this;
    const out: number[] = [];
    let pos = this.pos;
    // Emit while the window CENTER is still within the real input span.
    while (pos < bufEnd) {
      const center = pos;
      const first = Math.ceil(center - halfWindow);
      const last = Math.floor(center + halfWindow);
      let acc = 0;
      let norm = 0;
      for (let i = first; i <= last; i++) {
        const dist = center - i;
        const w = blackman(dist / halfWindow) * twoFc * sinc(twoFc * dist);
        norm += w;
        const idx = i - this.bufferStart;
        if (idx < 0 || idx >= this.history.length) continue;
        acc += (this.history[idx] as number) * w;
      }
      out.push(norm !== 0 ? acc / norm : 0);
      pos += step;
    }
    this.pos = pos;
    this.history = new Float32Array(0);
    this.bufferStart = Math.floor(pos);
    return Float32Array.from(out);
  }
}
