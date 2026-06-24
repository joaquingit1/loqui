#!/usr/bin/env node
/**
 * PRD-6 Google-Meet speaker-name attribution smoke launcher (hermetic; no
 * Electron, NO live Meet, no model, no network beyond a 127.0.0.1 listener it
 * asserts is loopback-only).
 *
 * Locates the workspace-pinned tsx runner and re-execs the REAL smoke body
 * (scripts/smoke-speakernames.ts) under it. The body imports the REAL
 * main-process modules — the loopback extension WS server, the PURE correlation
 * engine, and the name-applier that REUSES the PRD-5 diarized-rewrite path — and
 * drives them cross-process over a real `ws` client on 127.0.0.1. tsx is
 * required (not plain `node`) because the main-process TS source uses
 * `.js`-suffixed relative imports Node's type-stripping does not rewrite.
 *
 * Run via the root script: `pnpm smoke:speakernames`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BODY = join(__dirname, "smoke-speakernames.ts");

function resolveTsx() {
  const candidates = [
    join(REPO_ROOT, "node_modules/.bin/tsx"),
    join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
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
    "\nspeakernames smoke ERROR: could not locate the tsx TypeScript runner.\n" +
      "Install workspace deps first: `corepack pnpm install`.\n",
  );
  process.exit(1);
}

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
  process.stderr.write(`\nspeakernames smoke ERROR: failed to launch tsx: ${err.message}\n`);
  process.exit(1);
});
