/**
 * PRD-8 — the updater engine: orchestrates check -> download -> verify -> stage
 * -> (on restart) swap, and owns the {@link UpdaterState} surfaced to the UI.
 *
 * Flow (all IO injected so it is hermetically testable — NO real GitHub):
 *   1. `checkNow()` fetches the LATEST release's `version.json` manifest from the
 *      public GitHub repo (unauthenticated) and semver-compares it to the running
 *      version (via the pure manifest/semver modules).
 *   2. If newer AND there is an asset for this platform AND auto-download is on:
 *      download the asset to the staging dir via Node https (NOT a browser — the
 *      no-quarantine detail), VERIFY its sha256 BEFORE touching anything, and
 *      extract it to staging. Phase -> `ready`.
 *   3. `quitAndInstall()` spawns the DETACHED OS helper (swap + relaunch) and
 *      quits — only valid once a verified update is staged.
 *
 * Resilience (PRD-8 invariant): offline / rate-limit / partial-download / a
 * sha256 mismatch all fail SAFELY — the installed app is untouched, the error is
 * recorded on the state, and the next interval / manual check retries cleanly.
 * A check is single-flighted (a second call while one is in flight is a no-op
 * returning the current state) so the interval timer can never stack downloads.
 */
import { join } from "node:path";
import {
  updaterStateSchema,
  type UpdateManifest,
  type UpdaterSettings,
  type UpdaterState,
} from "@loqui/shared";
import { decideUpdate, parseManifest } from "./manifest.js";
import {
  Sha256MismatchError,
  downloadAndVerify,
  extractVerified,
  type HttpGet,
} from "./download.js";
import {
  spawnUpdateHelper,
  type DetachedSpawn,
  type ResolveHelperInput,
} from "./helper.js";

/**
 * Fetch the latest-release manifest JSON. Injectable: prod uses a Node-`fetch`
 * GitHub-API getter (see {@link makeGithubManifestFetcher}); tests stub it with a
 * fixture (or a throw, to exercise offline). Returns the raw parsed JSON (the
 * engine validates it via the shared schema).
 */
export type FetchManifest = () => Promise<unknown>;

export interface UpdaterEngineDeps {
  /** The running app version (`app.getVersion()`). */
  currentVersion: string;
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** Fetch the latest release manifest JSON (public GitHub, unauthenticated). */
  fetchManifest: FetchManifest;
  /** Where to download + extract the staged update. */
  stagingDir: string;
  /** HTTP GET for the asset download (defaults to the streamed HTTPS getter). */
  httpGet?: HttpGet;
  /** Inputs needed to spawn the detached helper (resolved from AppPaths). */
  helperInput: () => Omit<ResolveHelperInput, "stagedPath">;
  /** Detached helper spawner (injectable). */
  detachedSpawn?: DetachedSpawn;
  /** Quit the app after handing off to the helper. */
  quit: () => void;
  /** Clock for lastCheckedAt timestamps. Defaults to Date.now via new Date(). */
  now?: () => Date;
  /** Emitted on every state change (the IPC bridge pushes it to the renderer). */
  onStateChange?: (state: UpdaterState) => void;
}

export class UpdaterEngine {
  private state: UpdaterState;
  private settings: UpdaterSettings;
  private checking = false;
  /** The verified, extracted staging root once a download completes. */
  private stagedRoot: string | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly deps: UpdaterEngineDeps,
    settings: UpdaterSettings,
  ) {
    this.settings = settings;
    this.now = deps.now ?? (() => new Date());
    this.state = updaterStateSchema.parse({
      currentVersion: deps.currentVersion,
      phase: "idle",
    });
  }

  /** Current state snapshot (cloned so callers cannot mutate internal state). */
  getState(): UpdaterState {
    return { ...this.state };
  }

  /** Apply new settings live (the caller restarts the interval timer). */
  applySettings(settings: UpdaterSettings): void {
    this.settings = settings;
  }

  /**
   * Check GitHub for an update NOW. Single-flighted: returns the current state
   * unchanged if a check is already running. On any failure the installed app is
   * untouched and the error lands on the state (`phase:"error"`).
   */
  async checkNow(): Promise<UpdaterState> {
    if (this.checking) return this.getState();
    // A staged, ready update is terminal until restart — don't re-check over it.
    if (this.state.phase === "ready") return this.getState();
    this.checking = true;
    this.patch({ phase: "checking", error: null });
    try {
      const raw = await this.deps.fetchManifest();
      const manifest = this.toManifest(raw);
      const decision = decideUpdate(
        manifest,
        this.deps.currentVersion,
        this.deps.platform,
        this.deps.arch,
      );
      if (!decision.isUpdate || !decision.asset) {
        this.patch({
          phase: "up-to-date",
          availableVersion: null,
          notes: "",
          lastCheckedAt: this.iso(),
          downloadProgress: null,
        });
        return this.getState();
      }

      // A newer version exists for this platform.
      if (!this.settings.autoDownload) {
        // Notify-only: surface availability without staging.
        this.patch({
          phase: "idle",
          availableVersion: decision.version,
          notes: decision.notes,
          lastCheckedAt: this.iso(),
          downloadProgress: null,
        });
        return this.getState();
      }

      this.patch({
        phase: "downloading",
        availableVersion: decision.version,
        notes: decision.notes,
        downloadProgress: 0,
        lastCheckedAt: this.iso(),
      });

      const zipPath = await downloadAndVerify(decision.asset, this.deps.stagingDir, {
        httpGet: this.deps.httpGet,
        onProgress: (received, total) => {
          const p = total > 0 ? Math.min(1, received / total) : null;
          if (p !== null) this.patch({ downloadProgress: p });
        },
      });
      const extractRoot = await extractVerified(zipPath, join(this.deps.stagingDir, "extracted"));
      this.stagedRoot = extractRoot;
      this.patch({ phase: "ready", downloadProgress: 1 });
      return this.getState();
    } catch (err) {
      this.stagedRoot = null;
      this.patch({
        phase: "error",
        downloadProgress: null,
        lastCheckedAt: this.iso(),
        error: describeError(err),
      });
      return this.getState();
    } finally {
      this.checking = false;
    }
  }

  /**
   * Apply a staged, verified update: spawn the detached helper (swap + relaunch)
   * and quit. No-op unless the phase is `ready` and a staged root exists.
   */
  quitAndInstall(): void {
    if (this.state.phase !== "ready" || !this.stagedRoot) return;
    const base = this.deps.helperInput();
    // On macOS the staged root contains the new `.app`; the helper needs the
    // `.app` path. We pass the extracted root and let the helper locate the
    // `.app` (it globs `*.app`); on Windows the root's contents replace the dir.
    spawnUpdateHelper(
      { ...base, stagedPath: this.stagedRoot },
      this.deps.detachedSpawn,
    );
    this.deps.quit();
  }

  private toManifest(raw: unknown): UpdateManifest {
    // Validate the fetched JSON against the shared schema; a malformed manifest
    // throws here and becomes a clean `phase:"error"` (offline-resilience).
    return parseManifest(raw);
  }

  private patch(partial: Partial<UpdaterState>): void {
    this.state = updaterStateSchema.parse({ ...this.state, ...partial });
    this.deps.onStateChange?.(this.getState());
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

/** A short, non-secret description of a failure for the state's `error` field. */
function describeError(err: unknown): string {
  if (err instanceof Sha256MismatchError) {
    return "Update integrity check failed (sha256 mismatch); the installed app is unchanged.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
