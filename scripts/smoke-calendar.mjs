#!/usr/bin/env node
/**
 * PRD-15 calendar Home/"Today" smoke launcher (hermetic; no Electron, NO
 * network, no model).
 *
 * Locates the workspace-pinned tsx runner and re-execs the REAL smoke body
 * (scripts/smoke-calendar.ts) under it. The body imports the REAL main-process
 * calendar service + FakeCalendarProvider + the safeStorage-backed token store
 * and the meeting store, so the smoke exercises the actual PRD-15 wiring (the
 * FakeCalendarProvider is injected — no provider HTTP, no OAuth socket). tsx is
 * required (not plain `node`) because the main-process TS source uses
 * `.js`-suffixed relative imports Node's type-stripping does not rewrite.
 *
 * Run via the root script: `pnpm smoke:calendar`.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BODY = join(__dirname, "smoke-calendar.ts");

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
    "\ncalendar smoke ERROR: could not locate the tsx TypeScript runner.\n" +
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
  process.stderr.write(`\ncalendar smoke ERROR: failed to launch tsx: ${err.message}\n`);
  process.exit(1);
});
