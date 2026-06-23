import { describe, expect, it } from "vitest";
import { downmixToMono } from "./downmix.js";

describe("downmixToMono", () => {
  it("returns an empty buffer for zero channels", () => {
    const out = downmixToMono([]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it("returns a copy (not the same reference) for a single channel", () => {
    const ch = new Float32Array([0.1, -0.2, 0.3]);
    const out = downmixToMono([ch]);
    expect(Array.from(out)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(-0.2, 6),
      expect.closeTo(0.3, 6),
    ]);
    // mutating the output must not affect the input
    out[0] = 99;
    expect(ch[0]).toBeCloseTo(0.1, 6);
  });

  it("averages two channels sample-by-sample", () => {
    const l = new Float32Array([1, -1, 0.5, 0]);
    const r = new Float32Array([0, 1, -0.5, 0.4]);
    const out = downmixToMono([l, r]);
    expect(Array.from(out)).toEqual([
      expect.closeTo(0.5, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0.2, 6),
    ]);
  });

  it("averages N channels and stays within [-1, 1] for in-range inputs", () => {
    const a = new Float32Array([1, 1, 1]);
    const b = new Float32Array([1, 0, -1]);
    const c = new Float32Array([1, -1, -1]);
    const out = downmixToMono([a, b, c]);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(-1 / 3, 6);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("handles length-1 channels", () => {
    const out = downmixToMono([new Float32Array([0.5]), new Float32Array([-0.5])]);
    expect(out.length).toBe(1);
    expect(out[0]).toBeCloseTo(0, 6);
  });

  it("handles empty (length-0) channels", () => {
    const out = downmixToMono([new Float32Array(0), new Float32Array(0)]);
    expect(out.length).toBe(0);
  });

  it("tolerates differing channel lengths (max length, divisor stays N)", () => {
    const long = new Float32Array([1, 1, 1, 1]);
    const short = new Float32Array([1, 1]);
    const out = downmixToMono([long, short]);
    expect(out.length).toBe(4);
    // first two samples average over both channels
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    // tail: short contributes 0, divisor still 2 -> attenuated
    expect(out[2]).toBeCloseTo(0.5, 6);
    expect(out[3]).toBeCloseTo(0.5, 6);
  });
});
