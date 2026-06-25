/**
 * PRD-8 — pure manifest helpers: parse + validate the `version.json` release
 * manifest, pick the running platform's asset, and decide whether it represents
 * a newer version. No I/O — the engine feeds these the raw JSON it fetched and
 * the running version/platform.
 */
import {
  updateManifestSchema,
  updatePlatformKey,
  type UpdateAsset,
  type UpdateManifest,
} from "@loqui/shared";
import { isNewer } from "./semver.js";

/**
 * Parse + validate an arbitrary JSON value (or a JSON string) into an
 * {@link UpdateManifest}. Throws a clear error on a malformed manifest so the
 * engine treats it as a failed check (offline-resilience: the installed app is
 * untouched).
 */
export function parseManifest(raw: unknown): UpdateManifest {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return updateManifestSchema.parse(value);
}

export interface UpdateDecision {
  /** Whether the manifest version is strictly newer than the running version. */
  isUpdate: boolean;
  /** The manifest version (always present). */
  version: string;
  /** The release notes (may be empty). */
  notes: string;
  /**
   * The asset for the running platform, or null when the manifest has no build
   * for this platform/arch (treated as "no update available for me"). Only set
   * when `isUpdate` is true AND an asset exists.
   */
  asset: UpdateAsset | null;
}

/**
 * Decide whether the manifest offers a newer version for the running platform.
 *
 * `isUpdate` is true ONLY when the manifest version is strictly newer than
 * `currentVersion` AND the manifest carries an asset for `${platform}-${arch}`.
 * A newer version with no asset for this platform, or an older/equal version,
 * yields `isUpdate:false` (a no-op for the engine).
 */
export function decideUpdate(
  manifest: UpdateManifest,
  currentVersion: string,
  platform: string,
  arch: string,
): UpdateDecision {
  const key = updatePlatformKey(platform, arch);
  const asset = manifest.platforms[key] ?? null;
  const newer = isNewer(manifest.version, currentVersion);
  return {
    isUpdate: newer && asset !== null,
    version: manifest.version,
    notes: manifest.notes,
    asset: newer ? asset : null,
  };
}
