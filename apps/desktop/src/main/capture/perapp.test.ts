/**
 * PRD-13 per-app system-audio capability decision tests (PURE).
 *
 * Asserts the filter-vs-fallback decision logic: per-app filtering is chosen
 * ONLY when the user opted in AND the OS supports a per-process tap; every other
 * combination gracefully falls back to full loopback. A throwing probe degrades
 * to unsupported (never crashes).
 */
import { describe, expect, it } from "vitest";
import {
  decideCaptureMode,
  defaultCaptureCapabilityProbe,
  type CaptureCapabilityProbe,
} from "./perapp.js";

function probe(supported: boolean, platform: NodeJS.Platform = "darwin"): CaptureCapabilityProbe {
  return { platform, release: "23.4.0", supportsProcessTap: () => supported };
}

describe("decideCaptureMode", () => {
  it("chooses per-app when requested AND supported", () => {
    const cap = decideCaptureMode(true, probe(true));
    expect(cap.supported).toBe(true);
    expect(cap.mode).toBe("per-app");
  });

  it("falls back to full loopback when requested but UNSUPPORTED", () => {
    const cap = decideCaptureMode(true, probe(false, "win32"));
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe("full-loopback");
    expect(cap.reason).toMatch(/full loopback/i);
  });

  it("stays on full loopback when not requested, even if supported", () => {
    const cap = decideCaptureMode(false, probe(true));
    expect(cap.mode).toBe("full-loopback");
    expect(cap.supported).toBe(true); // capability reported, just not enabled
  });

  it("does not crash when the probe throws (degrades to unsupported)", () => {
    const throwing: CaptureCapabilityProbe = {
      platform: "linux",
      release: "x",
      supportsProcessTap: () => {
        throw new Error("native module missing");
      },
    };
    const cap = decideCaptureMode(true, throwing);
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe("full-loopback");
  });

  it("the default production probe reports unsupported (native tap not yet wired)", () => {
    const cap = decideCaptureMode(true, defaultCaptureCapabilityProbe("darwin", "23.4.0"));
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe("full-loopback");
  });
});
