#!/usr/bin/env node
/**
 * Bundle the AudioWorklet (PRD-1) into a SINGLE self-contained classic script.
 *
 * The capture worklet (src/renderer/capture/capture.worklet.ts → @loqui/audio's
 * capture-worklet → the DSP modules + @loqui/shared) is loaded at runtime via
 * `audioContext.audioWorklet.addModule(url)`. An AudioWorkletGlobalScope CANNOT
 * resolve bare/relative imports, so the file handed to addModule must have every
 * dependency inlined. Vite does NOT emit this for us (the `new URL(...)` asset
 * pattern doesn't bundle deps), which is why addModule was 404-ing and capture
 * failed with `AbortError: "The user aborted a request."` (PRD-1 gap).
 *
 * We bundle it with esbuild into `src/renderer/public/capture-worklet.js`. Vite
 * serves `public/` at the web root in dev AND copies it into `out/renderer/` on
 * build, so the controller can load it via `new URL("capture-worklet.js",
 * document.baseURI)` identically in both. `registerProcessor("loqui-capture")`
 * runs at top level in the worklet scope.
 */
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "src/renderer/public");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/renderer/capture/capture.worklet.ts")],
  outfile: resolve(outDir, "capture-worklet.js"),
  bundle: true,
  // A classic self-executing script — the most compatible shape for addModule
  // (registerProcessor runs immediately in the worklet global scope).
  format: "iife",
  target: "es2022",
  platform: "browser",
  sourcemap: false,
  logLevel: "info",
});

console.log("[build-worklet] wrote src/renderer/public/capture-worklet.js");
