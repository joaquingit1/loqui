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
import { createRequire } from "node:module";
import { build as esbuild } from "esbuild";

const require = createRequire(import.meta.url);

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
      // Resolve the package + pull the native-lib packages whole (their .dylibs +
      // data files are loaded dynamically, so PyInstaller's static analysis misses
      // them without --collect-all).
      "--paths",
      join(repoRoot, "sidecar"),
      "--collect-all",
      "ctranslate2",
      "--collect-all",
      "faster_whisper",
      "--collect-all",
      "sherpa_onnx",
      "--collect-all",
      "onnxruntime",
      "--collect-all",
      "av",
      // Bundle the emitted JSON Schemas the sidecar validates against (it can't
      // walk to packages/shared/schema from inside the .app). schemas.py reads
      // them from <_MEIPASS>/schema when frozen.
      "--add-data",
      `${join(repoRoot, "packages", "shared", "schema")}:schema`,
      // Absolute-import entry (NOT __main__.py directly — that breaks relative
      // imports + the dependency analysis).
      join(repoRoot, "sidecar", "pyinstaller_entry.py"),
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

// --- MCP server (esbuild-bundled, self-contained) ----------------------------
// The raw tsc dist has bare imports (@loqui/shared, @modelcontextprotocol/sdk,
// zod, better-sqlite3) that don't resolve in the .app (no node_modules there).
// Bundle the JS deps into ONE file; keep the native better-sqlite3 external and
// ship it + its runtime loader (bindings, file-uri-to-path) beside the bundle so
// `require('bindings')('better_sqlite3.node')` resolves. The bin path is
// unchanged (dist/bin/loqui-mcp.js) so the lifecycle + Claude Code registration
// still point at it.
try {
  const mcpEntry = join(repoRoot, "mcp-server", "dist", "bin", "loqui-mcp.js");
  if (existsSync(mcpEntry)) {
    log("bundling the MCP server (esbuild; better-sqlite3 external)…");
    rmSync(mcpOut, { recursive: true, force: true });
    mkdirSync(join(mcpOut, "dist", "bin"), { recursive: true });
    await esbuild({
      entryPoints: [mcpEntry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external: ["better-sqlite3"],
      outfile: join(mcpOut, "dist", "bin", "loqui-mcp.js"),
    });
    // type:module so Node treats the bundled .js as ESM.
    cpSync(join(repoRoot, "mcp-server", "package.json"), join(mcpOut, "package.json"));
    // Copy the native module + its runtime loader, resolved from each other's
    // perspective (pnpm), into the bundle's node_modules so the external import
    // walks up to them. better-sqlite3's .node is the Electron-ABI build.
    const copyPkg = (name, fromReq) => {
      const dir = dirname(fromReq.resolve(`${name}/package.json`));
      cpSync(dir, join(mcpOut, "node_modules", name), { recursive: true, dereference: true });
      return dir;
    };
    const bsqDir = copyPkg("better-sqlite3", require);
    const bsqReq = createRequire(join(bsqDir, "package.json"));
    const bindingsDir = copyPkg("bindings", bsqReq);
    copyPkg("file-uri-to-path", createRequire(join(bindingsDir, "package.json")));
    log(`mcp bundled -> ${mcpOut}`);
  } else {
    warn("mcp-server/dist not found — run `pnpm --filter @loqui/mcp-server build` first.");
  }
} catch (err) {
  warn(`mcp staging skipped/failed: ${err.message}`);
}

log("done.");
