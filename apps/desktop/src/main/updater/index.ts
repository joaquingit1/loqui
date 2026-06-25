/**
 * @file Main-process custom GitHub auto-updater (PRD-8) public surface.
 *
 * Re-exports the updater manager (periodic check + settings + engine), the IPC
 * bridge (state/settings/checkNow/quitAndInstall + the state push), the pure
 * manifest/semver helpers, the download+verify+extract IO, the detached-helper
 * handoff, the `version.json` generator, the GitHub manifest fetcher, and the
 * packaged-vs-dev path resolver — so the bootstrap, the release tooling, and the
 * tests import from one place.
 *
 * INVARIANT (re-asserted at the module boundary, PRD-8 / invariant #2): the
 * updater downloads ONLY public GitHub release assets and verifies each against
 * the manifest sha256 BEFORE touching the installed app — there is NO Loqui
 * server. A sha256 mismatch aborts with the old version fully intact; offline /
 * rate-limit / partial-download fail safely and retry on the next check.
 */
export { UpdaterManager, type UpdaterManagerDeps, type UpdaterSettingsSink } from "./manager.js";
export { UpdaterEngine, type UpdaterEngineDeps, type FetchManifest } from "./engine.js";
export { registerUpdaterIpc, makeUpdaterStatePush, type UpdaterIpcDeps } from "./register.js";
export { makeGithubManifestFetcher, type FetchFn, type GithubFetcherOptions } from "./github.js";
export { AppPaths, findAppBundle, type AppLike, type ResolverEnv } from "./paths.js";
export { compareVersions, isNewer, parseVersion } from "./semver.js";
export { parseManifest, decideUpdate, type UpdateDecision } from "./manifest.js";
export {
  downloadAndVerify,
  extractVerified,
  sha256,
  assetFileName,
  defaultHttpGet,
  Sha256MismatchError,
  type HttpGet,
  type DownloadVerifyDeps,
} from "./download.js";
export { extractZip } from "./zip.js";
export {
  resolveHelperPlan,
  spawnUpdateHelper,
  defaultDetachedSpawn,
  type HelperPlan,
  type ResolveHelperInput,
  type DetachedSpawn,
} from "./helper.js";
export {
  buildManifest,
  generateVersionJson,
  sha256File,
  assetName,
  type ArtifactInput,
  type HashedAsset,
  type FileHasher,
} from "./versionjson.js";
