#!/usr/bin/env node
/**
 * PRD-3 meeting end-to-end smoke test (no model, no devices, no Electron, no
 * microphone, no network).
 *
 * This is the launcher: it locates a TypeScript runner (tsx, pinned in the
 * workspace lockfile) and re-execs the REAL smoke body (scripts/smoke-meeting.ts)
 * under it. The body imports the REAL main-process source — the MeetingStore,
 * the append-only TranscriptWriter, the final-segment consumer, and the meeting
 * lifecycle controller — so the smoke covers the actual PRD-3 wiring, not a
 * reimplementation. tsx is required (not plain `node`) because the main-process
 * TS source uses `.js`-suffixed relative imports that Node's type-stripping does
 * not rewrite.
 *
 * Run via the root script: `pnpm smoke:meeting`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BODY = join(__dirname, "smoke-meeting.ts");

/**
 * Resolve the tsx CLI entry. tsx is a workspace-pinned dependency (present in
 * the committed pnpm-lock); we resolve it from the pnpm content-addressed store
 * without adding a manifest edge. Try the conventional .bin shim first, then the
 * pnpm store layout.
 */
function resolveTsx() {
  const candidates = [
    join(REPO_ROOT, "node_modules/.bin/tsx"),
    join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // pnpm store: node_modules/.pnpm/tsx@<version>/node_modules/tsx/dist/cli.mjs
  const pnpmDir = join(REPO_ROOT, "node_modules/.pnpm");
  if (existsSync(pnpmDir)) {
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith("tsx@"));
    if (entry) {
      const p = join(pnpmDir, entry, "node_modules/tsx/dist/cli.mjs");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const tsx = resolveTsx();
if (!tsx) {
  process.stderr.write(
    "\nmeeting smoke ERROR: could not locate the tsx TypeScript runner.\n" +
      "Install workspace deps first: `corepack pnpm install`.\n",
  );
  process.exit(1);
}

// If tsx is the .bin shim it is directly executable; if it is a .mjs entry we
// run it with the current node.
const isShim = tsx.endsWith("/tsx") || tsx.endsWith("\\tsx");
const cmd = isShim ? tsx : process.execPath;
const args = isShim
  ? [BODY, ...process.argv.slice(2)]
  : [tsx, BODY, ...process.argv.slice(2)];

const child = spawn(cmd, args, { stdio: "inherit", cwd: REPO_ROOT });
child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (err) => {
  process.stderr.write(`\nmeeting smoke ERROR: failed to launch tsx: ${err.message}\n`);
  process.exit(1);
});
