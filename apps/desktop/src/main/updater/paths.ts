/**
 * PRD-8 — packaged-vs-dev path resolution for the updater + bundled runtime.
 *
 * The updater (and the sidecar/MCP supervisor) need to know, at runtime:
 *   - where the INSTALLED app lives (to swap it),
 *   - which executable to RELAUNCH after the swap,
 *   - where to STAGE the download/extraction,
 *   - where the bundled HELPER scripts are,
 *   - and where the bundled sidecar / MCP binaries are.
 *
 * All of these differ between dev (running from source via electron-vite) and a
 * packaged app (running from inside `<App>.app` / the Windows install dir). This
 * module centralizes that resolution behind an injectable {@link AppPaths} view of
 * the Electron `app` (isPackaged, paths, exe) + `process` (platform, resourcesPath)
 * so it is unit-testable without Electron — the SAME seam PRD-0's launcher needs
 * for the packaged sidecar path.
 *
 * Layout of a packaged build (electron-builder, see electron-builder.yml):
 *   macOS:   Loqui.app/Contents/Resources/{app.asar, build-helpers/, sidecar/, mcp/}
 *   Windows: <install>/resources/{app.asar, build-helpers/, sidecar/, mcp/}
 *            <install>/Loqui.exe
 * `process.resourcesPath` points at `.../Resources` (mac) / `.../resources` (win)
 * in a packaged app — the `extraResources` (build-helpers, sidecar, mcp) land
 * there. In dev we fall back to the repo's on-disk `build-helpers/` + the uv/source
 * sidecar.
 */
import { existsSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** The minimal slice of Electron `app` the resolver needs (injectable for tests). */
export interface AppLike {
  isPackaged: boolean;
  /** `app.getAppPath()` — the app dir (…/Resources/app.asar when packaged). */
  getAppPath(): string;
  /** `app.getPath(name)` — used for "userData"/"temp" staging roots. */
  getPath(name: "userData" | "temp" | "exe"): string;
}

export interface ResolverEnv {
  /** `process.platform`. */
  platform: string;
  /** `process.resourcesPath` (only meaningful in a packaged app). */
  resourcesPath?: string | undefined;
  /** `process.execPath` — the running executable. */
  execPath: string;
}

/** Walk UP from a start dir until `marker` (a relative path) exists; null if none. */
function findUp(start: string, marker: string, maxDepth = 12): string | null {
  let dir = start;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The resolved, platform-correct paths the updater + supervisor consume.
 */
export class AppPaths {
  constructor(
    private readonly app: AppLike,
    private readonly env: ResolverEnv,
  ) {}

  get isPackaged(): boolean {
    return this.app.isPackaged;
  }

  get platform(): string {
    return this.env.platform;
  }

  /**
   * The directory bundled `extraResources` (build-helpers/, sidecar/, mcp/) live
   * in. Packaged: `process.resourcesPath`. Dev: the repo root (so the on-disk
   * `build-helpers/` + `sidecar/` resolve).
   */
  resourcesDir(): string {
    if (this.app.isPackaged && this.env.resourcesPath) return this.env.resourcesPath;
    // Dev: find the repo root by its sidecar/pyproject.toml marker (same anchor
    // the launcher uses), falling back to the module's nearest ancestor with a
    // build-helpers/ dir.
    const here = join(fileURLToPath(import.meta.url), "..");
    return (
      findUp(here, join("sidecar", "pyproject.toml")) ??
      findUp(here, "build-helpers") ??
      here
    );
  }

  /** Absolute path to the bundled OS update helper script for this platform. */
  helperScript(): string {
    const name = this.env.platform === "win32" ? "update-helper.ps1" : "update-helper.sh";
    return join(this.resourcesDir(), "build-helpers", name);
  }

  /**
   * The INSTALLED app location the helper swaps.
   *   - macOS: the running `<App>.app` bundle (walk up from the exe to the
   *     `.app` — `…/<App>.app/Contents/MacOS/<exe>`).
   *   - Windows / Linux: the directory containing the running exe (the portable
   *     app dir).
   */
  installPath(): string {
    const exe = this.env.execPath;
    if (this.env.platform === "darwin") {
      const app = findAppBundle(exe);
      if (app) return app;
    }
    // Resolve with the TARGET platform's path semantics, so a Windows exe path
    // (backslash-separated) resolves correctly even when this runs on a POSIX
    // host (e.g. the macOS/Linux CI runners) where the default dirname would
    // treat the whole path as one segment and return ".".
    return this.env.platform === "win32" ? win32.dirname(exe) : dirname(exe);
  }

  /**
   * The executable to RELAUNCH after the swap. On macOS the helper `open`s the
   * `.app`; on Windows it `Start-Process`-es the exe. We hand the helper the
   * INSTALL path (mac) / the running exe path (win) — the helper resolves the
   * actual binary inside the freshly-swapped tree.
   */
  relaunchTarget(): string {
    if (this.env.platform === "darwin") return this.installPath();
    return this.env.execPath;
  }

  /**
   * A per-run staging directory under userData (writable on both OSes, outside
   * the install dir so a partial download never pollutes the app). The engine
   * cleans it between runs.
   */
  stagingDir(): string {
    return join(this.app.getPath("userData"), "updates");
  }

  /**
   * Resolve the bundled Python sidecar binary directory (onedir PyInstaller / a
   * python-build-standalone tree under `resources/sidecar/`). Returns null in dev
   * (the launcher then falls back to `uv run`). Packaged: the dir that contains
   * the `loqui-sidecar` executable.
   */
  bundledSidecarBin(): string | null {
    if (!this.app.isPackaged) return null;
    const exe = this.env.platform === "win32" ? "loqui-sidecar.exe" : "loqui-sidecar";
    const candidate = join(this.resourcesDir(), "sidecar", exe);
    return existsSync(candidate) ? candidate : null;
  }

  /**
   * Resolve the bundled MCP server binary. Returns null in dev (the lifecycle
   * resolver then falls back to the built JS bin / PATH). Packaged: the
   * `loqui-mcp` executable under `resources/mcp/`.
   */
  bundledMcpBin(): string | null {
    if (!this.app.isPackaged) return null;
    const exe = this.env.platform === "win32" ? "loqui-mcp.exe" : "loqui-mcp";
    const candidate = join(this.resourcesDir(), "mcp", exe);
    return existsSync(candidate) ? candidate : null;
  }
}

/** Walk up from a macOS executable to its enclosing `*.app` bundle, or null. */
export function findAppBundle(exePath: string): string | null {
  let dir = dirname(exePath);
  for (let i = 0; i < 6; i++) {
    if (dir.endsWith(".app")) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
