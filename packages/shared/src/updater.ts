/**
 * PRD-8 — shared packaging + self-updater contract seams.
 *
 * The single source of truth for the cross-process shapes the custom GitHub
 * auto-updater types against (main owns the check/download/swap; the renderer +
 * tray reflect state). Kept in @loqui/shared (zod + emitted JSON Schema) so main,
 * preload, the renderer, the `version.json` generator, and the release tooling
 * all type against ONE definition. @loqui/shared stays zod-only — NO node/electron
 * deps here.
 *
 *   - {@link UpdateManifest} — the `version.json` release manifest published with
 *     every GitHub Release: the latest version, notes, and a per-platform asset
 *     (url + sha256 + size). The app fetches the latest release's manifest
 *     (public repo, unauthenticated) on launch + on an interval and semver-
 *     compares it against the running version.
 *   - {@link UpdaterSettings} — the persisted, additive + defaulted policy
 *     (auto-check ON by default, ~30 min interval) read by the settings store +
 *     the Settings UI. An older `app-settings.json` (or a missing `updater` key)
 *     loads forward to the defaults.
 *   - {@link UpdaterState} — the runtime status surfaced to the renderer + tray
 *     (current version, phase, the available version, last-checked time, the
 *     download progress, and any error). The "off" state is the all-defaults value.
 *
 * INTEGRITY (invariant #2): the updater downloads ONLY public GitHub release
 * assets and verifies each against the manifest sha256 BEFORE touching the
 * installed app — there is NO Loqui server and no telemetry. A sha256 mismatch
 * aborts the update with the old version fully intact.
 *
 * Every field is ADDITIVE + DEFAULTED so a partial payload / older config parses
 * forward (mirroring CaptureSettings / AutoRecordSettings / McpStatus).
 */
import { z } from "zod";

// --- The release source (public GitHub repo) ----------------------------------

/**
 * The public GitHub repo the updater polls for releases. Unauthenticated
 * requests (60/hr) are ample for a launch + ~30-min-interval poll. Override at
 * build time is unnecessary; the repo is fixed for the published app.
 */
export const UPDATER_REPO_OWNER = "joaquingit1" as const;
export const UPDATER_REPO_NAME = "loqui" as const;

/** The manifest asset name attached to every release (the update feed). */
export const UPDATE_MANIFEST_ASSET = "version.json" as const;

/** Default auto-check interval: ~30 minutes (PRD-8). */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Floor for the configurable interval (avoid hammering / rate-limit). */
export const MIN_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// --- The platform key (matches process.platform + process.arch) ---------------

/**
 * The per-platform manifest key: `${process.platform}-${process.arch}` for the
 * targets we ship. Exactly the keys the `version.json` `platforms` map uses and
 * the running app derives at check time to pick its asset.
 */
export const UPDATE_PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "win32-x64"] as const;
export type UpdatePlatformKey = (typeof UPDATE_PLATFORM_KEYS)[number];

/**
 * Compose the platform key from a platform + arch (the running app passes
 * `process.platform`, `process.arch`). Pure; returns the raw `${platform}-${arch}`
 * string (which may or may not be a published key — the caller looks it up in
 * the manifest and treats a miss as "no asset for this platform").
 */
export function updatePlatformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

// --- The per-platform release asset -------------------------------------------

/**
 * One platform's downloadable update asset: the absolute (https) URL of the
 * update-channel artifact (a zipped `.app` on macOS, a portable zip on Windows),
 * its sha256 (hex, lowercase — the integrity check that stands in for a code
 * signature), and its size in bytes (0 allowed = unknown; used only for progress).
 */
export const updateAssetSchema = z.object({
  url: z.string().url(),
  /** Lowercase hex sha256 of the asset. Verified BEFORE the swap; mismatch aborts. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars"),
  /** Asset size in bytes (0 = unknown). For progress display + a sanity check. */
  size: z.number().int().nonnegative().default(0),
});
export type UpdateAsset = z.infer<typeof updateAssetSchema>;

/**
 * The `version.json` release manifest. Published as a release asset with each
 * GitHub Release and fetched by the updater. `platforms` maps a
 * {@link UpdatePlatformKey} to that platform's {@link UpdateAsset}; a platform may
 * be absent (no build for it that release), which the app treats as "no update
 * available for me".
 */
export const updateManifestSchema = z.object({
  /** The release's semantic version (e.g. "1.2.3"). Compared against the running app. */
  version: z.string().min(1),
  /** Human release notes (markdown/plain). May be empty. */
  notes: z.string().default(""),
  /** ISO publish time, when known (informational). */
  pubDate: z.string().datetime({ offset: true }).optional(),
  /** Per-platform assets, keyed by `${platform}-${arch}`. */
  platforms: z.record(z.string(), updateAssetSchema),
});
export type UpdateManifest = z.infer<typeof updateManifestSchema>;

// --- The persisted updater policy (additive + defaulted) ----------------------

/**
 * The persisted updater policy (`<dataRoot>/app-settings.json` under the
 * `updater` key). Additive + defaulted so an older config loads forward.
 *
 * AUTO-CHECK ON BY DEFAULT (PRD-8): the app checks GitHub on launch + every
 * `intervalMs`. The user can disable auto-check (then only "Check for updates
 * now" runs) and tune the interval (floored at {@link MIN_UPDATE_CHECK_INTERVAL_MS}).
 */
export const updaterSettingsSchema = z.object({
  /** Auto-check on launch + interval. ON by default. */
  autoCheck: z.boolean().default(true),
  /**
   * Auto-check interval in ms. Defaults to {@link DEFAULT_UPDATE_CHECK_INTERVAL_MS}
   * (~30 min); the engine floors it at {@link MIN_UPDATE_CHECK_INTERVAL_MS}.
   */
  intervalMs: z.number().int().positive().default(DEFAULT_UPDATE_CHECK_INTERVAL_MS),
  /**
   * Whether to download + stage a newer version automatically (then prompt to
   * restart). ON by default — the swap still only happens on an explicit restart.
   * When off, the app only NOTIFIES that an update is available.
   */
  autoDownload: z.boolean().default(true),
});
export type UpdaterSettings = z.infer<typeof updaterSettingsSchema>;

/** Patch accepted by `setUpdaterSettings` — any subset of the fields. */
export const updateUpdaterSettingsSchema = updaterSettingsSchema.partial();
export type UpdateUpdaterSettings = z.infer<typeof updateUpdaterSettingsSchema>;

// --- The runtime updater state (main -> renderer + tray) ----------------------

/**
 * The high-level updater phase surfaced to the renderer + tray:
 *   - `idle`        — not currently checking; no update pending.
 *   - `checking`    — fetching + comparing the manifest.
 *   - `downloading` — a newer version is downloading to the staging dir.
 *   - `ready`       — a verified newer version is staged; restart to apply.
 *   - `up-to-date`  — the last check found no newer version.
 *   - `error`       — the last check/download failed (offline / rate-limit /
 *     partial download / sha256 mismatch); the installed app is intact and the
 *     engine retries on the next interval / manual check.
 */
export const updaterPhaseSchema = z
  .enum(["idle", "checking", "downloading", "ready", "up-to-date", "error"])
  .default("idle");
export type UpdaterPhase = z.infer<typeof updaterPhaseSchema>;

/**
 * The updater runtime state pushed to the renderer (and returned by the status
 * invoke) + read by the tray. Every field defaulted; the all-defaults value is a
 * fresh idle updater on the running version.
 */
export const updaterStateSchema = z.object({
  /** The running app version (from `app.getVersion()`). */
  currentVersion: z.string().default("0.0.0"),
  /** The high-level phase. */
  phase: updaterPhaseSchema,
  /**
   * The newer version that was found / staged, or null when none. Set in
   * `downloading`/`ready`; cleared on `up-to-date`.
   */
  availableVersion: z.string().nullable().default(null),
  /** Release notes for the available version (when known). */
  notes: z.string().default(""),
  /** ISO time of the last completed check (success OR failure), or null. */
  lastCheckedAt: z.string().datetime({ offset: true }).nullable().default(null),
  /** Download progress in [0,1] while `downloading`, else null. */
  downloadProgress: z.number().min(0).max(1).nullable().default(null),
  /** A short non-secret error note for the last failure, or null. */
  error: z.string().nullable().default(null),
});
export type UpdaterState = z.infer<typeof updaterStateSchema>;
