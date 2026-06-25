#!/usr/bin/env node
/**
 * PRD-8 — generate the `version.json` release manifest from built artifacts.
 *
 * Run by .github/workflows/release.yml after electron-builder produces the
 * per-platform update-channel zips. It maps each expected artifact to its
 * `${platform}-${arch}` manifest key, hashes it (sha256), reads its size,
 * composes its GitHub-Release download URL from the tag, and writes a
 * schema-valid `version.json`.
 *
 * Usage:
 *   node scripts/gen-version-json.mjs \
 *     --version 1.2.3 \
 *     --repo owner/name \
 *     --artifacts-dir apps/desktop/dist-app \
 *     --out version.json \
 *     [--notes "release notes"]
 *
 * Artifacts are matched by the electron-builder artifactName pattern
 * `Loqui-<version>-<arch>-<os>.zip`. A missing artifact for a platform is simply
 * omitted from the manifest (the updater treats a missing platform as
 * "no update for me"), so a single-OS release still produces a valid manifest.
 *
 * This is a thin I/O wrapper over the pure generator in
 * apps/desktop/src/main/updater/versionjson.ts — kept dependency-free (node only)
 * so it runs in CI without a build step. The hashing + composition logic mirrors
 * generateVersionJson exactly (and is covered by versionjson.test.ts).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = val;
    }
  }
  return args;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// The platforms we ship + the electron-builder artifact name pieces (os/arch).
// `os` matches electron-builder's ${os} token (mac/win); `arch` the ${arch}.
const TARGETS = [
  { key: "darwin-arm64", os: "mac", arch: "arm64" },
  { key: "darwin-x64", os: "mac", arch: "x64" },
  { key: "win32-x64", os: "win", arch: "x64" },
];

async function main() {
  const args = parseArgs(process.argv);
  const version = args.version;
  const repo = args.repo; // owner/name
  const artifactsDir = args["artifacts-dir"] ?? ".";
  const out = args.out ?? "version.json";
  const notes = args.notes ?? "";
  if (!version || !repo) {
    console.error("usage: gen-version-json.mjs --version <v> --repo <owner/name> [--artifacts-dir <dir>] [--out <file>] [--notes <text>]");
    process.exit(2);
  }

  const tag = version.startsWith("v") ? version : `v${version}`;
  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
  const platforms = {};

  for (const t of TARGETS) {
    const name = `Loqui-${version}-${t.arch}-${t.os}.zip`;
    const file = join(artifactsDir, name);
    if (!existsSync(file)) {
      console.warn(`[gen-version-json] skipping missing artifact: ${name}`);
      continue;
    }
    const sha256 = await sha256File(file);
    const size = statSync(file).size;
    platforms[t.key] = { url: `${baseUrl}/${encodeURIComponent(name)}`, sha256, size };
    console.log(`[gen-version-json] ${t.key}: ${name} (${size} bytes, sha256 ${sha256.slice(0, 12)}…)`);
  }

  if (Object.keys(platforms).length === 0) {
    console.error("[gen-version-json] no artifacts found — refusing to write an empty manifest");
    process.exit(1);
  }

  const manifest = {
    version,
    notes,
    pubDate: new Date().toISOString(),
    platforms,
  };
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`[gen-version-json] wrote ${out} for ${Object.keys(platforms).length} platform(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
