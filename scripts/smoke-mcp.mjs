#!/usr/bin/env node
/**
 * PRD-7 MCP-server smoke test (hermetic; no Electron, no network beyond
 * loopback-stdio, no model, no API key).
 *
 * Proves the STANDALONE, STRICTLY READ-ONLY `loqui-mcp` server works with the
 * app CLOSED: it seeds a temp LOQUI_DATA_DIR that looks EXACTLY like one the
 * app's writer store produced (the same index.db FTS schema + the same
 * per-meeting file layout from @loqui/shared), spawns the REAL built bin
 * (mcp-server/dist/bin/loqui-mcp.js) over stdio, drives it with the official MCP
 * SDK Client over a StdioClientTransport, and asserts:
 *   - MCP `initialize` handshake succeeds (server identity exposed);
 *   - `tools/list` returns EXACTLY the 5 read-only tools (list_meetings,
 *     search_meetings, get_meeting, get_transcript, get_summary) and NO mutator
 *     (no create/update/delete/append/write/edit tool exists — there is no
 *     write code path);
 *   - `search_meetings` finds a keyword across BOTH the transcript and summary
 *     FTS columns and returns the seeded meeting with a snippet;
 *   - `get_transcript` returns the seeded transcript body (diarized preferred);
 *   - `get_summary` returns the seeded structured summary.
 *
 * The server core reads the SAME index.db (opened readonly) + the SAME files via
 * the shared read-only reader, so this also guards against writer/reader schema
 * drift. Exits non-zero on the first failure.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const mcpPkgDir = join(repoRoot, "mcp-server");
const binPath = join(mcpPkgDir, "dist", "bin", "loqui-mcp.js");

// Resolve dependencies (better-sqlite3 for seeding; the MCP SDK client; the
// shared layout constants) from the mcp-server package so we use the SAME
// versions the server itself loads — no separate install.
const require = createRequire(join(mcpPkgDir, "package.json"));

function fail(msg) {
  console.error(`\n[smoke-mcp] FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

// --- Build the bin if needed --------------------------------------------------
if (!existsSync(binPath)) {
  console.error("[smoke-mcp] building @loqui/mcp-server (dist bin missing)…");
  const r = spawnSync("corepack", ["pnpm", "--filter", "@loqui/mcp-server", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (r.status !== 0) fail("could not build @loqui/mcp-server");
  assert(existsSync(binPath), `built bin not found at ${binPath}`);
}

// --- Seed a temp data root that mirrors the app writer's layout ---------------
const Database = require("better-sqlite3");
// @loqui/shared is ESM-only (exports only the `import` condition), so load the
// layout constants via a dynamic import of its built dist `main` — the SAME
// single source of truth the server reads, so the seed can't drift from the
// reader's file layout. The package.json isn't in the export map, so locate it
// under the mcp-server package's resolved node_modules and read its `main`.
const sharedPkgDir = join(mcpPkgDir, "node_modules", "@loqui", "shared");
const sharedPkg = require(join(sharedPkgDir, "package.json"));
const sharedMain = resolve(sharedPkgDir, sharedPkg.main);
const {
  INDEX_DB_NAME,
  MEETINGS_DIR_NAME,
  MEETING_META_FILE,
  MEETING_LIVE_TRANSCRIPT_FILE,
  MEETING_DIARIZED_TRANSCRIPT_MD_FILE,
  MEETING_SUMMARY_FILE,
} = await import(`file://${sharedMain}`);

const dataRoot = mkdtempSync(join(tmpdir(), "loqui-smoke-mcp-"));

// Distinctive markers we assert flow back through the tools.
const TRANSCRIPT_MARKER = "quarterly-roadmap-zephyr";
const SUMMARY_MARKER = "ship-the-zephyr-milestone";
const id = randomUUID();
const now = new Date().toISOString();

const meeting = {
  id,
  title: "Zephyr planning sync",
  platform: null,
  startedAt: now,
  endedAt: now,
  status: "done",
  participants: [],
  modelVersions: {},
  createdAt: now,
  updatedAt: now,
};

const liveTranscript = `You said: Let's review the ${TRANSCRIPT_MARKER} for next quarter.\nThey said: Agreed, we lock scope this week.\n`;
const diarizedMd = `# Diarized transcript\n\n**You:** Let's review the ${TRANSCRIPT_MARKER} for next quarter.\n\n**Speaker 1:** Agreed, we lock scope this week.\n`;
const summary = {
  meetingId: id,
  version: 1,
  tldr: `Team aligned to ${SUMMARY_MARKER} and locked scope.`,
  decisions: ["Lock scope this week."],
  actionItems: [],
  topics: ["roadmap"],
  provider: "fake",
  model: "fake",
  generatedAt: now,
};

function seed() {
  const meetingsDir = join(dataRoot, MEETINGS_DIR_NAME);
  mkdirSync(meetingsDir, { recursive: true });

  // index.db: the SAME schema the app writer (apps/desktop store/db.ts) emits —
  // the meetings table + the standalone meetings_fts FTS5 table whose column
  // order (meeting_id, title, transcript, summary) the shared read SQL assumes.
  const db = new Database(join(dataRoot, INDEX_DB_NAME));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id          TEXT PRIMARY KEY NOT NULL,
      title       TEXT NOT NULL DEFAULT '',
      platform    TEXT,
      status      TEXT NOT NULL DEFAULT 'recording',
      started_at  TEXT,
      ended_at    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON meetings (created_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
      meeting_id UNINDEXED,
      title,
      transcript,
      summary,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  db.prepare(
    `INSERT INTO meetings (id, title, platform, status, started_at, ended_at, created_at, updated_at)
     VALUES (@id, @title, @platform, @status, @startedAt, @endedAt, @createdAt, @updatedAt)`,
  ).run({
    id: meeting.id,
    title: meeting.title,
    platform: meeting.platform,
    status: meeting.status,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
  });
  // FTS row: transcript marker in the transcript column, summary marker in the
  // summary column — so a single search across BOTH columns can be exercised.
  db.prepare(
    `INSERT INTO meetings_fts (meeting_id, title, transcript, summary) VALUES (?, ?, ?, ?)`,
  ).run(meeting.id, meeting.title, liveTranscript, summary.tldr);
  db.close();

  const dir = join(meetingsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MEETING_META_FILE), `${JSON.stringify(meeting, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, MEETING_LIVE_TRANSCRIPT_FILE), liveTranscript, "utf8");
  writeFileSync(join(dir, MEETING_DIARIZED_TRANSCRIPT_MD_FILE), diarizedMd, "utf8");
  writeFileSync(join(dir, MEETING_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function main() {
  seed();

  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

  // Spawn the REAL built bin over stdio with the seeded temp data root. The app
  // is NOT running — the server reads index.db (readonly) + files directly.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    env: { ...process.env, LOQUI_DATA_DIR: dataRoot },
    stderr: "pipe",
  });
  const client = new Client({ name: "loqui-smoke-mcp", version: "0.0.0" });

  try {
    await client.connect(transport); // performs the MCP initialize handshake
    console.error("[smoke-mcp] initialize handshake OK");

    // --- tools/list: exactly the 5 read tools, NO mutators --------------------
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const expected = [
      "get_meeting",
      "get_summary",
      "get_transcript",
      "list_meetings",
      "search_meetings",
    ];
    assert(
      JSON.stringify(names) === JSON.stringify(expected),
      `tools/list mismatch. expected ${JSON.stringify(expected)}, got ${JSON.stringify(names)}`,
    );
    // No write/mutator tool may exist under ANY name.
    const mutator = names.find((n) => /(create|update|delete|append|write|edit|insert|remove|set_|modify|patch)/i.test(n));
    assert(!mutator, `a mutator tool exists: ${mutator} (server must be strictly read-only)`);
    console.error(`[smoke-mcp] tools/list OK: ${names.join(", ")}`);

    const textOf = (res) => {
      const t = (res.content ?? []).find((c) => c.type === "text");
      return t?.text ?? "";
    };

    // --- search_meetings: finds the keyword, returns the seeded meeting -------
    const searchRes = await client.callTool({
      name: "search_meetings",
      arguments: { query: TRANSCRIPT_MARKER },
    });
    assert(!searchRes.isError, `search_meetings returned an error result: ${textOf(searchRes)}`);
    const search = searchRes.structuredContent ?? JSON.parse(textOf(searchRes));
    assert(Array.isArray(search.hits) && search.hits.length >= 1, "search_meetings returned no hits");
    const hit = search.hits.find((h) => h.meeting?.id === id);
    assert(hit, `search_meetings did not return the seeded meeting ${id}`);
    assert(typeof hit.snippet === "string" && hit.snippet.length > 0, "search hit had no snippet");
    console.error(`[smoke-mcp] search_meetings OK (snippet: ${JSON.stringify(hit.snippet)})`);

    // search across the SUMMARY column too (different word, summary-only marker).
    const searchSummary = await client.callTool({
      name: "search_meetings",
      arguments: { query: SUMMARY_MARKER },
    });
    const ss = searchSummary.structuredContent ?? JSON.parse(textOf(searchSummary));
    const summaryHit = Array.isArray(ss.hits)
      ? ss.hits.find((h) => h.meeting?.id === id)
      : undefined;
    assert(
      summaryHit !== undefined,
      "search_meetings did not match a summary-only keyword (FTS must span the summary column)",
    );
    // The snippet for a summary-only hit must cite the SUMMARY (PRD-7 AC#3),
    // not return unrelated/empty transcript text.
    assert(
      typeof summaryHit.snippet === "string" &&
        summaryHit.snippet.includes(SUMMARY_MARKER) &&
        summaryHit.snippet.includes("["),
      `summary-only hit returned an unusable snippet: ${JSON.stringify(summaryHit.snippet)}`,
    );
    console.error("[smoke-mcp] search_meetings spans the summary column with a usable snippet OK");

    // --- get_transcript: returns the seeded transcript body -------------------
    const transRes = await client.callTool({
      name: "get_transcript",
      arguments: { id },
    });
    assert(!transRes.isError, `get_transcript returned an error result: ${textOf(transRes)}`);
    const trans = transRes.structuredContent ?? JSON.parse(textOf(transRes));
    assert(
      typeof trans.text === "string" && trans.text.includes(TRANSCRIPT_MARKER),
      `get_transcript did not return the seeded transcript content; got ${JSON.stringify(trans.text)}`,
    );
    console.error(`[smoke-mcp] get_transcript OK (variant: ${trans.variant})`);

    // --- get_summary: returns the seeded structured summary -------------------
    const sumRes = await client.callTool({
      name: "get_summary",
      arguments: { id },
    });
    assert(!sumRes.isError, `get_summary returned an error result: ${textOf(sumRes)}`);
    const sum = sumRes.structuredContent ?? JSON.parse(textOf(sumRes));
    assert(sum.summary && sum.summary.meetingId === id, "get_summary did not return the seeded summary");
    assert(
      typeof sum.summary.tldr === "string" && sum.summary.tldr.includes(SUMMARY_MARKER),
      `get_summary tldr missing the seeded marker; got ${JSON.stringify(sum.summary.tldr)}`,
    );
    console.error("[smoke-mcp] get_summary OK");

    // --- a write attempt has no code path (unknown/mutator tool name) ---------
    let writeRejected = false;
    try {
      const r = await client.callTool({ name: "delete_meeting", arguments: { id } });
      writeRejected = r.isError === true; // unknown tool -> error result, never a mutation
    } catch {
      writeRejected = true; // protocol-level rejection is also acceptable
    }
    assert(writeRejected, "an unknown 'delete_meeting' tool call was NOT rejected (no write path may exist)");
    console.error("[smoke-mcp] write attempt has no available path OK");

    console.error("\n[smoke-mcp] PASS — standalone read-only MCP server served real seeded content over stdio.");
  } finally {
    await client.close().catch(() => {});
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fail(String(err?.stack ?? err));
});
