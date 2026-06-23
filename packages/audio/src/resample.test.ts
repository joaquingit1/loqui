import { describe, expect, it } from "vitest";
import { resample, resampleTo16k, StreamingResampler } from "./resample.js";

const TARGET = 16000;

/** Generate `durationSec` seconds of a sine at `freq` Hz sampled at `rate`. */
function sine(freq: number, rate: number, durationSec: number, amp = 0.8): Float32Array {
  const n = Math.round(rate * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

/** Energy of the signal in a frequency band [lo, hi] Hz via a coarse DFT. */
function bandEnergy(signal: Float32Array, rate: number, lo: number, hi: number): number {
  const n = signal.length;
  // Step the DFT in ~25 Hz bins to keep it cheap but resolved.
  const binHz = 25;
  let energy = 0;
  for (let f = lo; f <= hi; f += binHz) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / rate;
    for (let i = 0; i < n; i++) {
      const s = signal[i] as number;
      re += s * Math.cos(w * i);
      im -= s * Math.sin(w * i);
    }
    energy += (re * re + im * im) / (n * n);
  }
  return energy;
}

describe("resampleTo16k — passthrough", () => {
  it("returns a copy unchanged when input is already 16 kHz", () => {
    const input = sine(440, TARGET, 0.05);
    const out = resampleTo16k(input, TARGET);
    expect(out.length).toBe(input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
    // it is a copy, not the same reference
    out[0] = 999;
    expect(input[0]).not.toBe(999);
  });
});

describe("resampleTo16k — output length / rate correctness", () => {
  it("downsamples 48 kHz -> 16 kHz to ~1/3 the samples", () => {
    const input = sine(440, 48000, 0.1); // 4800 samples
    const out = resampleTo16k(input, 48000);
    expect(out.length).toBe(Math.round((input.length * TARGET) / 48000));
    expect(out.length).toBe(1600);
  });

  it("downsamples 44.1 kHz -> 16 kHz with the correct length", () => {
    const input = sine(440, 44100, 0.1); // 4410 samples
    const out = resampleTo16k(input, 44100);
    expect(out.length).toBe(Math.round((input.length * TARGET) / 44100));
  });

  it("upsamples 8 kHz -> 16 kHz to ~2x the samples", () => {
    const input = sine(440, 8000, 0.1); // 800 samples
    const out = resampleTo16k(input, 8000);
    expect(out.length).toBe(1600);
  });

  it("general resample to an arbitrary rate has the right length", () => {
    const input = sine(440, 48000, 0.05);
    const out = resample(input, 48000, 22050);
    expect(out.length).toBe(Math.round((input.length * 22050) / 48000));
  });
});

describe("resampleTo16k — preserves an in-band tone", () => {
  it("keeps a 1 kHz tone (well below 8 kHz Nyquist) intact in amplitude", () => {
    const input = sine(1000, 48000, 0.2, 0.8);
    const out = resampleTo16k(input, 48000);
    // ignore filter warm-up / edge transients
    const core = out.subarray(200, out.length - 200);
    let peak = 0;
    for (const v of core) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThan(0.95);
  });
});

describe("resampleTo16k — anti-aliasing (the load-bearing test)", () => {
  it("does NOT fold a 15 kHz tone into the 0–8 kHz band when downsampling 48k->16k", () => {
    // 15 kHz is above the 8 kHz output Nyquist. Naive decimation would alias it
    // to |15000 - 16000| = 1000 Hz, a loud spurious tone. A proper anti-alias
    // filter must suppress it: almost no energy should land in 0–8 kHz.
    const input = sine(15000, 48000, 0.2, 0.9);
    const out = resampleTo16k(input, 48000);

    const aliasBand = bandEnergy(out, TARGET, 200, 7800);
    // Reference: a real 1 kHz tone at the same amplitude, resampled the same way.
    const ref = resampleTo16k(sine(1000, 48000, 0.2, 0.9), 48000);
    const refBand = bandEnergy(ref, TARGET, 200, 7800);

    // The aliased energy must be far below a genuine in-band tone (>40 dB down).
    expect(aliasBand).toBeLessThan(refBand * 1e-4);
  });

  it("suppresses a 20 kHz tone (would alias near 4 kHz) below -40 dB", () => {
    const input = sine(20000, 48000, 0.2, 0.9); // aliases to |20000-16000| = 4000 Hz
    const out = resampleTo16k(input, 48000);
    const aliasEnergy = bandEnergy(out, TARGET, 3500, 4500);
    const ref = resampleTo16k(sine(4000, 48000, 0.2, 0.9), 48000);
    const refEnergy = bandEnergy(ref, TARGET, 3500, 4500);
    expect(aliasEnergy).toBeLessThan(refEnergy * 1e-4);
  });

  it("passes a near-Nyquist in-band tone (7 kHz) through with real energy", () => {
    const out = resampleTo16k(sine(7000, 48000, 0.2, 0.8), 48000);
    const inBand = bandEnergy(out, TARGET, 6800, 7200);
    expect(inBand).toBeGreaterThan(1e-3);
  });
});

describe("resample — adversarial inputs", () => {
  it("returns empty for empty input at any rate", () => {
    expect(resampleTo16k(new Float32Array(0), 48000).length).toBe(0);
    expect(resampleTo16k(new Float32Array(0), 16000).length).toBe(0);
  });

  it("handles a length-1 input without throwing", () => {
    const out = resampleTo16k(new Float32Array([0.5]), 48000);
    expect(out).toBeInstanceOf(Float32Array);
    // 1 input sample @48k -> round(1*16000/48000) = round(0.333) = 0 samples
    expect(out.length).toBe(0);
  });

  it("handles a length-1 input that upsamples to >= 1 sample", () => {
    const out = resampleTo16k(new Float32Array([0.5]), 8000);
    expect(out.length).toBe(Math.round((1 * TARGET) / 8000)); // 2
  });

  it("does not propagate NaN/Inf input into output as NaN", () => {
    // floatToPcm16 sanitizes, but the resampler should also not produce NaN
    // from a finite-but-extreme input.
    const input = new Float32Array(480).fill(0);
    input[100] = 1e20;
    const out = resampleTo16k(input, 48000);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("throws on a non-positive or non-finite input rate", () => {
    expect(() => resampleTo16k(new Float32Array([1, 2]), 0)).toThrow();
    expect(() => resampleTo16k(new Float32Array([1, 2]), -48000)).toThrow();
    expect(() => resampleTo16k(new Float32Array([1, 2]), NaN)).toThrow();
    expect(() => resampleTo16k(new Float32Array([1, 2]), Infinity)).toThrow();
  });

  it("handles a non-multiple length (odd sample count) cleanly", () => {
    const input = sine(440, 48000, 0.0317); // not a round number of output frames
    const out = resampleTo16k(input, 48000);
    expect(out.length).toBe(Math.round((input.length * TARGET) / 48000));
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it("does not introduce a DC offset on a zero-mean signal", () => {
    const out = resampleTo16k(sine(1000, 48000, 0.2), 48000);
    const core = out.subarray(200, out.length - 200);
    let sum = 0;
    for (const v of core) sum += v;
    const mean = sum / core.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
  });
});

/**
 * The streaming resampler is what the AudioWorklet ACTUALLY runs per render
 * quantum. These tests feed a continuous tone in 128-sample blocks (the Web
 * Audio quantum) and assert the concatenated streaming output matches the
 * one-shot resample — the coverage gap that let the per-quantum-zero-pad bug
 * (~34 dB attenuation) and the +0.78% clock skew pass undetected.
 */
describe("StreamingResampler — matches one-shot resample, chunked at 128", () => {
  const QUANTUM = 128;

  /** Run a whole signal through the streaming resampler in 128-sample chunks. */
  function streamChunked(input: Float32Array, inRate: number, outRate = TARGET): Float32Array {
    const rs = new StreamingResampler(inRate, outRate);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += QUANTUM) {
      parts.push(rs.process(input.subarray(i, Math.min(i + QUANTUM, input.length))));
    }
    parts.push(rs.flush());
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  it("emits exactly 16000 Hz (no per-block rounding skew) over 1 s of 48 kHz", () => {
    const input = sine(1000, 48000, 1.0);
    const out = streamChunked(input, 48000);
    // One-shot would be round(48000 * 16000/48000) = 16000 samples; the
    // streaming path must match to within a sample or two of startup latency,
    // NOT the 16125 the buggy per-quantum round() produced.
    const oneShot = resample(input, 48000, TARGET);
    expect(Math.abs(out.length - oneShot.length)).toBeLessThanOrEqual(2);
    // Hard skew bound: definitely not the +0.78% (16125) drift.
    expect(out.length).toBeLessThan(16100);
    expect(out.length).toBeGreaterThan(15900);
  });

  it("reproduces the one-shot 1 kHz tone (no block-boundary corruption)", () => {
    const input = sine(1000, 48000, 0.5, 0.8);
    const streamed = streamChunked(input, 48000);
    const oneShot = resample(input, 48000, TARGET);
    // Compare the steady-state core (skip filter warm-up at both ends).
    const skip = 200;
    const n = Math.min(streamed.length, oneShot.length) - skip;
    let maxErr = 0;
    for (let i = skip; i < n; i++) {
      maxErr = Math.max(maxErr, Math.abs((streamed[i] as number) - (oneShot[i] as number)));
    }
    // Streaming carries real history, so the core must match closely.
    expect(maxErr).toBeLessThan(1e-3);
  });

  it("preserves the 1 kHz fundamental amplitude (the bug collapsed it ~34 dB)", () => {
    const input = sine(1000, 48000, 0.5, 0.8);
    const streamed = streamChunked(input, 48000);
    const core = streamed.subarray(200, streamed.length - 200);
    let peak = 0;
    for (const v of core) peak = Math.max(peak, Math.abs(v));
    // Buggy per-quantum path peaked ~0.012; correct path is ~0.8.
    expect(peak).toBeGreaterThan(0.7);
    expect(peak).toBeLessThan(0.95);
  });

  it("still anti-aliases a 15 kHz tone when streamed in 128-sample chunks", () => {
    const streamed = streamChunked(sine(15000, 48000, 0.3, 0.9), 48000);
    const refStreamed = streamChunked(sine(1000, 48000, 0.3, 0.9), 48000);
    const aliasBand = bandEnergy(streamed, TARGET, 200, 7800);
    const refBand = bandEnergy(refStreamed, TARGET, 200, 7800);
    expect(aliasBand).toBeLessThan(refBand * 1e-3);
  });

  it("handles 44.1 kHz -> 16 kHz chunked with the right length", () => {
    const input = sine(1000, 44100, 0.5);
    const out = streamChunked(input, 44100);
    const oneShot = resample(input, 44100, TARGET);
    expect(Math.abs(out.length - oneShot.length)).toBeLessThanOrEqual(2);
  });

  it("passthrough at 16 kHz returns the input unchanged across chunks", () => {
    const input = sine(440, TARGET, 0.1);
    const out = streamChunked(input, TARGET);
    expect(out.length).toBe(input.length);
    let maxErr = 0;
    for (let i = 0; i < input.length; i++) {
      maxErr = Math.max(maxErr, Math.abs((out[i] as number) - (input[i] as number)));
    }
    expect(maxErr).toBe(0);
  });

  it("elapsedMs tracks the cumulative INPUT clock, not the output count", () => {
    const rs = new StreamingResampler(48000, TARGET);
    rs.process(sine(1000, 48000, 0.5));
    // 0.5 s of 48 kHz input fed -> 500 ms elapsed regardless of emitted count.
    expect(rs.inputSamplesSeen).toBe(Math.round(48000 * 0.5));
    expect(Math.abs(rs.elapsedMs - 500)).toBeLessThan(1e-6);
  });

  it("rejects an invalid input rate", () => {
    expect(() => new StreamingResampler(0)).toThrow();
    expect(() => new StreamingResampler(NaN)).toThrow();
    expect(() => new StreamingResampler(-48000)).toThrow();
  });
});
