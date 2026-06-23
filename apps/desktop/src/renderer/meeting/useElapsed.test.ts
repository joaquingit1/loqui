/**
 * useElapsed + formatElapsed tests (jsdom). Fake timers + injected clock keep
 * the ticker deterministic — no reliance on real wall-clock time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { formatElapsed, useElapsed } from "./useElapsed.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const START = "2026-06-23T10:00:00.000Z";
const START_MS = Date.parse(START);

describe("formatElapsed", () => {
  it("formats sub-hour as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5)).toBe("0:05");
    expect(formatElapsed(65)).toBe("1:05");
    expect(formatElapsed(600)).toBe("10:00");
  });
  it("formats past an hour as h:mm:ss", () => {
    expect(formatElapsed(3661)).toBe("1:01:01");
  });
  it("clamps negatives / NaN to 0:00", () => {
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("useElapsed", () => {
  it("returns 0 with no start", () => {
    const { result } = renderHook(() =>
      useElapsed({ startedAt: null, running: false, now: () => START_MS }),
    );
    expect(result.current).toBe(0);
  });

  it("ticks once per second while running", () => {
    vi.useFakeTimers();
    let clock = START_MS + 2000; // 2s in at mount
    const { result } = renderHook(() =>
      useElapsed({ startedAt: START, running: true, now: () => clock }),
    );
    expect(result.current).toBe(2);

    act(() => {
      clock = START_MS + 5000;
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(5);
  });

  it("freezes to endedAt when stopped", () => {
    const { result } = renderHook(() =>
      useElapsed({
        startedAt: START,
        endedAt: "2026-06-23T10:00:42.000Z",
        running: false,
        now: () => START_MS + 999999,
      }),
    );
    expect(result.current).toBe(42);
  });
});
