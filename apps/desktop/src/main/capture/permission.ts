/**
 * macOS Screen-Recording permission handling for system / loopback audio
 * capture (PRD-1, unit "main-capture-orchestration").
 *
 * On macOS 13+, Electron's loopback audio (the `{ audio: "loopback" }` path of
 * `setDisplayMediaRequestHandler`) is backed by ScreenCaptureKit, which is
 * gated by the **Screen Recording** privacy permission — the same one used for
 * screen *video* capture. So even though Loqui only wants the system audio, the
 * OS shows the "Screen Recording" prompt and the user must grant it in
 * System Settings ▸ Privacy & Security ▸ Screen Recording.
 *
 * macOS quirks this module encodes:
 *   - The permission cannot be requested programmatically for screen-recording
 *     (there is no `askForMediaAccess("screen")`); the prompt only appears the
 *     first time capture is actually attempted. So before first capture the
 *     status is `not-determined` and we surface that to the renderer with an
 *     explanatory onboarding affordance rather than a hard error.
 *   - After the user toggles the permission ON in System Settings, the running
 *     app often still sees the OLD value until it is **relaunched** — the grant
 *     does not take effect for the current process. We detect this
 *     "needs-restart" case so the UI can prompt a relaunch instead of looping.
 *   - Non-macOS platforms need no such grant -> `not-applicable`.
 *
 * Everything that touches Electron / the OS is injected so the mapping,
 * deep-link, and needs-restart logic are hermetically testable with no real
 * permission state.
 */
import type { ScreenPermissionStatus } from "@loqui/shared";

/**
 * Deep link that opens System Settings directly at
 * Privacy & Security ▸ Screen Recording (macOS Ventura+ also accepts the older
 * `Privacy_ScreenCapture` anchor). The renderer's recovery UI passes this to
 * {@link openScreenSettings}.
 */
export const SCREEN_SETTINGS_DEEP_LINK =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" as const;

/** Raw value of Electron's `systemPreferences.getMediaAccessStatus("screen")`. */
export type RawMediaAccessStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

/** Seams injected so the resolver is testable without real Electron / OS state. */
export interface ScreenPermissionEnv {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to a fn calling `systemPreferences.getMediaAccessStatus("screen")`. */
  getMediaAccessStatus?: () => RawMediaAccessStatus;
}

/**
 * Map Electron's raw screen media-access status onto the shared
 * {@link ScreenPermissionStatus} contract. Non-macOS -> `not-applicable`;
 * `unknown` (and anything unexpected) is treated conservatively as
 * `not-determined` so the UI prompts rather than blocks.
 */
export function resolveScreenPermission(env: ScreenPermissionEnv = {}): ScreenPermissionStatus {
  const platform = env.platform ?? process.platform;
  if (platform !== "darwin") return "not-applicable";
  const get = env.getMediaAccessStatus;
  // If we can't read the status (no injected getter on a non-Electron host),
  // fall back to not-determined rather than throwing on the orchestration path.
  if (!get) return "not-determined";
  let raw: RawMediaAccessStatus;
  try {
    raw = get();
  } catch {
    return "not-determined";
  }
  switch (raw) {
    case "granted":
    case "denied":
    case "restricted":
    case "not-determined":
      return raw;
    case "unknown":
    default:
      return "not-determined";
  }
}

/** Whether the given status blocks system/loopback capture right now. */
export function isCaptureBlocked(status: ScreenPermissionStatus): boolean {
  return status === "denied" || status === "restricted";
}

/**
 * Whether the UI should surface the onboarding / recovery affordance for the
 * given status. `not-determined` -> explain why we need it (first prompt);
 * `denied` -> deep-link to settings; `restricted` -> tell the user it's blocked
 * by policy (MDM, not user-recoverable). `granted` / `not-applicable` -> no UI.
 */
export function needsPermissionUi(status: ScreenPermissionStatus): boolean {
  return status === "denied" || status === "restricted" || status === "not-determined";
}

/** Result of {@link openScreenSettings}. */
export interface OpenSettingsResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/** Seam injected so opening System Settings is testable without Electron's shell. */
export interface OpenSettingsEnv {
  platform?: NodeJS.Platform;
  /** Defaults to a fn calling `shell.openExternal(url)`. */
  openExternal?: (url: string) => Promise<void>;
}

/**
 * Open System Settings at the Screen-Recording pane via the deep link. No-op
 * (returns `ok:false`, `code:"not-applicable"`) on non-macOS. Never throws —
 * a failure to open is surfaced as `ok:false` for the UI to handle.
 */
export async function openScreenSettings(
  env: OpenSettingsEnv = {},
): Promise<OpenSettingsResult> {
  const platform = env.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, code: "not-applicable", message: "screen permission is macOS-only" };
  }
  const open = env.openExternal;
  if (!open) {
    return { ok: false, code: "no_shell", message: "no openExternal available" };
  }
  try {
    await open(SCREEN_SETTINGS_DEEP_LINK);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      code: "open_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect the macOS "granted but needs a relaunch to take effect" case.
 *
 * After the user enables Screen Recording in System Settings, the OS does not
 * retroactively grant the running process: a capture attempt still fails even
 * though `getMediaAccessStatus("screen")` may now report `granted`. The
 * reliable signal we have is: the live status reads `granted` BUT a capture
 * attempt just failed (the renderer reports the loopback track produced no
 * audio / the request was rejected). When that combination holds, the right
 * remedy is to prompt the user to restart Loqui — not to retry in a loop.
 *
 * @param liveStatus the freshly-read {@link ScreenPermissionStatus}.
 * @param captureFailed whether the most recent capture attempt failed.
 */
export function needsRestartAfterGrant(
  liveStatus: ScreenPermissionStatus,
  captureFailed: boolean,
): boolean {
  return liveStatus === "granted" && captureFailed;
}
