#!/usr/bin/env node
/**
 * PRD-8 — stage the bundled runtime (Python sidecar + MCP server) for packaging.
 *
 * electron-builder's `extraResources` (see ../electron-builder.yml) copies
 *   apps/desktop/build/runtime/sidecar -> <Resources>/sidecar
 *   apps/desktop/build/runtime/mcp     -> <Resources>/mcp
 * into the packaged app, where the main process resolves them via
 * process.resourcesPath (see src/main/updater/paths.ts -> bundledSidecarBin /
 * bundledMcpBin). This script produces those two trees.
 *
 * SIDECAR (Python): built with PyInstaller in ONEDIR mode so the user needs NO
 * Python/uv. The onedir tree contains a `loqui-sidecar(.exe)` launcher that the
 * supervisor runs directly (see launcher.ts `bundledBinPath`). faster-whisper +
 * pyannote MODELS are NOT bundled — they download on first use (PRD-8) to keep
 * the installer lean.
 *
 *   Build command (run from the repo root, with uv + the sidecar deps synced):
 *     uv run --project sidecar pyinstaller \
 *       --noconfirm --onedir --name loqui-sidecar \
 *       --distpath apps/desktop/build/runtime \
 *       sidecar/loqui_sidecar/__main__.py
 *   => apps/desktop/build/runtime/loqui-sidecar/loqui-sidecar(.exe) + deps.
 *   (We then normalize the onedir folder name to `sidecar/`.)
 *
 * MCP (Node/TS): the standalone server is a Node program (mcp-server/dist/bin/
 * loqui-mcp.js + better-sqlite3). Rather than re-bundle a second Node, the
 * packaged app runs it with the SAME bundled Electron-as-node; we stage the built
 * mcp-server dist + its node_modules under `mcp/` and ship a tiny launcher.
 * (The bundled-bin resolver falls back to the built JS bin when no native exe is
 * present, so the app still works if this step is skipped in a dev package.)
 *
 * This script PERFORMS the staging when the upstream builds exist; it is
 * intentionally tolerant (warns + continues) so `pnpm build` of the desktop app
 * does not hard-fail in environments without PyInstaller — the release workflow
 * runs the full PyInstaller build before invoking it (see release.yml).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const runtimeDir = join(desktopRoot, "build", "runtime");
const sidecarOut = join(runtimeDir, "sidecar");
const mcpOut = join(runtimeDir, "mcp");

function log(msg) {
  console.log(`[build-runtime] ${msg}`);
}
function warn(msg) {
  console.warn(`[build-runtime] WARN: ${msg}`);
}

mkdirSync(runtimeDir, { recursive: true });

// --- Sidecar (PyInstaller onedir) -------------------------------------------
try {
  log("building the Python sidecar with PyInstaller (onedir)…");
  rmSync(sidecarOut, { recursive: true, force: true });
  // PyInstaller writes <distpath>/loqui-sidecar/. Build into a temp dist then
  // rename the onedir folder to `sidecar/` for a stable extraResources mapping.
  execFileSync(
    "uv",
    [
      "run",
      "--project",
      join(repoRoot, "sidecar"),
      "pyinstaller",
      "--noconfirm",
      "--onedir",
      "--name",
      "loqui-sidecar",
      "--distpath",
      runtimeDir,
      join(repoRoot, "sidecar", "loqui_sidecar", "__main__.py"),
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
  const built = join(runtimeDir, "loqui-sidecar");
  if (existsSync(built)) {
    rmSync(sidecarOut, { recursive: true, force: true });
    renameSync(built, sidecarOut);
    log(`sidecar staged -> ${sidecarOut}`);
  } else {
    warn("PyInstaller did not produce loqui-sidecar/ — sidecar not staged.");
  }
} catch (err) {
  warn(`sidecar build skipped/failed: ${err.message}`);
}

// --- MCP server (built JS dist + node_modules) -------------------------------
try {
  const mcpDist = join(repoRoot, "mcp-server", "dist");
  if (existsSync(mcpDist)) {
    log("staging the built MCP server dist…");
    rmSync(mcpOut, { recursive: true, force: true });
    mkdirSync(mcpOut, { recursive: true });
    cpSync(mcpDist, join(mcpOut, "dist"), { recursive: true });
    // Ship the MCP package.json so its bin path resolves.
    const pkg = join(repoRoot, "mcp-server", "package.json");
    if (existsSync(pkg)) cpSync(pkg, join(mcpOut, "package.json"));
    log(`mcp staged -> ${mcpOut}`);
  } else {
    warn("mcp-server/dist not found — run `pnpm --filter @loqui/mcp-server build` first.");
  }
} catch (err) {
  warn(`mcp staging skipped/failed: ${err.message}`);
}

log("done.");
