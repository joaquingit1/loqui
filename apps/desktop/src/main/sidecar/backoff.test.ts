import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKOFF,
  backoffBaseDelay,
  backoffDelay,
  shouldRetry,
  type BackoffOptions,
} from "./backoff.js";

const opts: BackoffOptions = {
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  factor: 2,
  jitter: 0.25,
  maxRetries: 5,
};

describe("backoffBaseDelay", () => {
  it("grows geometrically from the base by the factor", () => {
    expect(backoffBaseDelay(0, opts)).toBe(100);
    expect(backoffBaseDelay(1, opts)).toBe(200);
    expect(backoffBaseDelay(2, opts)).toBe(400);
    expect(backoffBaseDelay(3, opts)).toBe(800);
    expect(backoffBaseDelay(4, opts)).toBe(1_600);
  });

  it("clamps to maxDelayMs once the geometric value would exceed it", () => {
    expect(backoffBaseDelay(5, opts)).toBe(2_000); // 3200 -> capped
    expect(backoffBaseDelay(50, opts)).toBe(2_000);
  });

  it("handles extreme attempts without returning Infinity/NaN", () => {
    const d = backoffBaseDelay(2000, opts);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(2_000);
  });

  it("rejects negative attempts", () => {
    expect(() => backoffBaseDelay(-1, opts)).toThrow(RangeError);
  });
});

describe("backoffDelay (jitter)", () => {
  it("with jitter=0 equals the deterministic base delay", () => {
    const noJitter: BackoffOptions = { ...opts, jitter: 0 };
    expect(backoffDelay(2, noJitter, () => 0.999)).toBe(400);
  });

  it("rand=0 yields the low edge: base * (1 - jitter)", () => {
    // attempt 1 -> base 200, jitter 0.25 -> 200 * 0.75 = 150
    expect(backoffDelay(1, opts, () => 0)).toBeCloseTo(150, 6);
  });

  it("rand→1 approaches the high edge: base * (1 + jitter)", () => {
    // attempt 1 -> base 200 -> 200 * (1 + 0.25 * (1 - epsilon)) ≈ 250
    const v = backoffDelay(1, opts, () => 1 - Number.EPSILON);
    expect(v).toBeGreaterThan(249);
    expect(v).toBeLessThanOrEqual(250);
  });

  it("rand=0.5 yields exactly the base (centered jitter)", () => {
    expect(backoffDelay(1, opts, () => 0.5)).toBeCloseTo(200, 6);
  });

  it("never exceeds maxDelayMs even at the high jitter edge", () => {
    // attempt where base is already capped at 2000; +jitter must re-clamp.
    const v = backoffDelay(10, opts, () => 1 - Number.EPSILON);
    expect(v).toBeLessThanOrEqual(opts.maxDelayMs);
  });

  it("is deterministic for a fixed rand across the whole range", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      for (const r of [0, 0.1, 0.37, 0.5, 0.83, 0.999]) {
        const a = backoffDelay(attempt, opts, () => r);
        const b = backoffDelay(attempt, opts, () => r);
        expect(a).toBe(b);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(opts.maxDelayMs);
      }
    }
  });
});

describe("shouldRetry", () => {
  it("permits attempts strictly below maxRetries", () => {
    expect(shouldRetry(0, opts)).toBe(true);
    expect(shouldRetry(4, opts)).toBe(true);
    expect(shouldRetry(5, opts)).toBe(false);
    expect(shouldRetry(6, opts)).toBe(false);
  });

  it("with maxRetries=0 never retries", () => {
    expect(shouldRetry(0, { ...opts, maxRetries: 0 })).toBe(false);
  });
});

describe("DEFAULT_BACKOFF", () => {
  it("is bounded and sane", () => {
    expect(DEFAULT_BACKOFF.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_BACKOFF.maxDelayMs).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.baseDelayMs);
    expect(DEFAULT_BACKOFF.factor).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_BACKOFF.jitter).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_BACKOFF.jitter).toBeLessThanOrEqual(1);
    expect(DEFAULT_BACKOFF.maxRetries).toBeGreaterThanOrEqual(0);
  });
});
