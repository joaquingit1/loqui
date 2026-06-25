/**
 * Per-app / per-process system-audio filtering: capability PROBE + decision
 * (PRD-13).
 *
 * The PRD asks to "capture only the meeting app's audio where the OS allows;
 * gate by OS capability with graceful fallback to full loopback." The real
 * per-process tap is a macOS Core Audio process-tap / ScreenCaptureKit
 * per-process path (macOS 14.4+) — and a Windows process-loopback path (Win10
 * 2004+) — that must be implemented + verified on those OSes. On this Windows
 * dev box the real tap is NOT implementable/testable, so this module ships the
 * CLEAN capability-probe + decision + fallback (the part that IS unit-testable
 * everywhere) behind an injectable probe, with a clear seam for the native tap.
 *
 * Nothing here crashes when unsupported: an unsupported OS (or the user not
 * opting in) resolves to `full-loopback`, exactly today's behavior.
 */
import {
  captureCapabilitySchema,
  type CaptureCapability,
} from "@loqui/shared";

/**
 * The platform probe surface. Injected so the decision is unit-testable on any
 * OS (tests pass a fake `{ platform, release, supportsProcessTap }`). Production
 * binds it to `process.platform` / `os.release()` + the native tap availability
 * check (the macOS Core Audio / ScreenCaptureKit seam).
 */
export interface CaptureCapabilityProbe {
  /** `process.platform` value ("darwin" | "win32" | "linux" | ...). */
  platform: NodeJS.Platform;
  /** OS release string (e.g. macOS "23.4.0" kernel, Windows "10.0.22631"). */
  release: string;
  /**
   * Whether the NATIVE per-process system-audio tap is available + wired on this
   * build. The default production probe returns false until the macOS Core Audio
   * tap / Windows process-loopback path is implemented + verified — so the
   * decision degrades to full loopback rather than claiming an unimplemented tap.
   */
  supportsProcessTap(): boolean;
}

/**
 * Decide the system-audio capture mode from the user preference + the OS
 * capability. PURE + DETERMINISTIC:
 *
 *   - perAppRequested && supported  -> "per-app"      (the opt-in tap)
 *   - perAppRequested && !supported -> "full-loopback" (graceful fallback)
 *   - !perAppRequested              -> "full-loopback" (default; no tap)
 *
 * Always returns a valid {@link CaptureCapability} with a human-readable reason;
 * never throws.
 */
export function decideCaptureMode(
  perAppRequested: boolean,
  probe: CaptureCapabilityProbe,
): CaptureCapability {
  const supported = safeSupported(probe);

  if (!perAppRequested) {
    return captureCapabilitySchema.parse({
      supported,
      mode: "full-loopback",
      reason: supported
        ? "per-app filtering available but not enabled; using full loopback"
        : "per-app filtering disabled; using full loopback",
    });
  }

  if (!supported) {
    return captureCapabilitySchema.parse({
      supported: false,
      mode: "full-loopback",
      reason: `per-app filtering not supported on ${probe.platform} ${probe.release}; falling back to full loopback`,
    });
  }

  return captureCapabilitySchema.parse({
    supported: true,
    mode: "per-app",
    reason: "per-app system-audio tap enabled",
  });
}

/** Call the probe's tap check defensively (a throwing probe => unsupported). */
function safeSupported(probe: CaptureCapabilityProbe): boolean {
  try {
    return probe.supportsProcessTap();
  } catch {
    return false;
  }
}

/**
 * The default production probe. Reports `supportsProcessTap() === false` until
 * the native macOS Core Audio process-tap / ScreenCaptureKit per-process path
 * (and the Windows process-loopback path) is implemented + verified on
 * Mac/CI — so the decision degrades to full loopback on every current build and
 * NOTHING crashes. When that native path lands, flip `supportsProcessTap` to a
 * real availability check (e.g. macOS >= 14.4 AND the tap module loaded).
 */
export function defaultCaptureCapabilityProbe(
  platform: NodeJS.Platform,
  release: string,
): CaptureCapabilityProbe {
  return {
    platform,
    release,
    supportsProcessTap: () => false,
  };
}
