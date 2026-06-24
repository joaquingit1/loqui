/**
 * PRD-6 — extension build (Foundation seam).
 *
 * Bundles the MV3 content script with esbuild and stages the static assets into
 * `dist/` so the folder is a loadable unpacked extension:
 *   - src/content.ts  -> dist/content.js   (IIFE bundle; MV3 content scripts are
 *                        NOT ESM, so we bundle to a single classic script with
 *                        `@loqui/shared` inlined — keeps the contract types/values
 *                        in lockstep with the app without a runtime import).
 *   - src/manifest.json -> dist/manifest.json (copied verbatim).
 *
 * Lightest viable toolchain (esbuild only). `--watch` rebuilds on change for
 * local Meet testing. No network, no codegen beyond bundling.
 */
import { build, context, type BuildOptions } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outdir = join(root, "dist");

/** Manifest version, inlined as a build-time define so the content script can
 *  report it in `hello` even where chrome.runtime.getManifest is unavailable. */
function readManifestVersion(): string {
  try {
    const raw = readFileSync(join(root, "src", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "";
  } catch {
    return "";
  }
}

const options: BuildOptions = {
  entryPoints: { content: join(root, "src", "content.ts") },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome116",
  platform: "browser",
  define: {
    __LOQUI_EXTENSION_VERSION__: JSON.stringify(readManifestVersion()),
  },
  // The content script is injected into Meet; keep it small + self-contained.
  minify: false,
  sourcemap: true,
  logLevel: "info",
};

function stageStatic(): void {
  mkdirSync(outdir, { recursive: true });
  copyFileSync(join(root, "src", "manifest.json"), join(outdir, "manifest.json"));
}

const watch = process.argv.includes("--watch");

stageStatic();
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[extension] watching for changes…");
} else {
  await build(options);
  console.log(`[extension] built -> ${outdir}`);
}
