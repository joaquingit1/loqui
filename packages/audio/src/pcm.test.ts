import { describe, expect, it } from "vitest";
import { floatToPcm16, pcm16ToFloat } from "./pcm.js";

describe("floatToPcm16", () => {
  it("returns an Int16Array of equal length", () => {
    const out = floatToPcm16(new Float32Array([0, 0.5, -0.5]));
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(3);
  });

  it("maps an empty buffer to an empty buffer", () => {
    expect(floatToPcm16(new Float32Array(0)).length).toBe(0);
  });

  it("maps 0 -> 0, +1 -> 32767, -1 -> -32767", () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32767);
  });

  it("scales mid values by 32767 with nearest rounding", () => {
    const out = floatToPcm16(new Float32Array([0.5, -0.5, 0.25]));
    expect(out[0]).toBe(Math.round(0.5 * 32767));
    expect(out[1]).toBe(Math.round(-0.5 * 32767));
    expect(out[2]).toBe(Math.round(0.25 * 32767));
  });

  it("clips values above +1 to 32767", () => {
    const out = floatToPcm16(new Float32Array([1.5, 2, 1000]));
    expect(Array.from(out)).toEqual([32767, 32767, 32767]);
  });

  it("clips values below -1 to -32767", () => {
    const out = floatToPcm16(new Float32Array([-1.5, -2, -1000]));
    expect(Array.from(out)).toEqual([-32767, -32767, -32767]);
  });

  it("clips +Infinity / -Infinity to the rails", () => {
    const out = floatToPcm16(new Float32Array([Infinity, -Infinity]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32767);
  });

  it("maps NaN to silence (0) without poisoning neighbors", () => {
    const out = floatToPcm16(new Float32Array([0.5, NaN, -0.5]));
    expect(out[0]).toBe(Math.round(0.5 * 32767));
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(Math.round(-0.5 * 32767));
  });

  it("never exceeds the int16 range for any garbage input", () => {
    const garbage = new Float32Array([
      1e30,
      -1e30,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      0.9999999,
      -0.9999999,
    ]);
    const out = floatToPcm16(garbage);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });
});

describe("pcm16ToFloat", () => {
  it("is an approximate inverse of floatToPcm16 within quantization error", () => {
    const original = new Float32Array([0, 0.25, -0.25, 0.5, -0.5, 0.9, -0.9]);
    const round = pcm16ToFloat(floatToPcm16(original));
    for (let i = 0; i < original.length; i++) {
      expect(round[i]).toBeCloseTo(original[i] as number, 3);
    }
  });

  it("keeps round-tripped values within [-1, 1)", () => {
    const round = pcm16ToFloat(floatToPcm16(new Float32Array([1, -1, 0.999, -0.999])));
    for (const v of round) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });
});
