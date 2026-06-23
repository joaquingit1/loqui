/**
 * The SQLite index at `<dataRoot>/index.db`.
 *
 * `meta.json` (per meeting, on disk) is the source of truth for a Meeting; this
 * database is a denormalized INDEX over those files used for fast listing,
 * date-range filtering, and full-text search. It can be rebuilt from the
 * meta.json files at any time.
 *
 * Schema:
 *   meetings      — one row per meeting, mirroring the indexable Meeting fields.
 *   meetings_fts  — an FTS5 virtual table over a meeting's searchable text
 *                   (title now; transcript + summary populated by later PRDs
 *                   via {@link upsertSearchText}).
 *
 * The FTS table is NOT content-linked to `meetings` (it is a standalone FTS5
 * table keyed by meeting id) so that transcript/summary text — which lives in
 * separate files and is appended incrementally — can be indexed independently
 * of the meetings row without triggers.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Meeting } from "@loqui/shared";
import { indexDbPath } from "./paths.js";

/** Schema version stored in `PRAGMA user_version`; bump on migrations. */
export const SCHEMA_VERSION = 2 as const;

export type IndexDb = Database.Database;

/**
 * Open (creating if needed) the SQLite index and ensure the schema exists.
 * Honors LOQUI_DATA_DIR via {@link indexDbPath}. Pass an explicit path (e.g.
 * ":memory:") only for tests that don't want a file.
 */
export function openIndexDb(path: string = indexDbPath()): IndexDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/** Create the tables/indexes if they do not already exist (idempotent). */
export function initSchema(db: IndexDb): void {
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

    -- Sort/filter index for the library list (date-desc + range scans).
    CREATE INDEX IF NOT EXISTS idx_meetings_created_at
      ON meetings (created_at DESC);

    -- Standalone FTS5 index over searchable meeting text. 'meeting_id' is
    -- UNINDEXED so it round-trips for joins/deletes without polluting matches.
    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
      meeting_id UNINDEXED,
      title,
      transcript,
      summary,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    -- Dedupe ledger for transcript-text indexing (PRD-3). One row per confirmed
    -- (meeting, segId) appended into the FTS transcript column, so a redelivered
    -- 'final' segment does not double-index its text. Rebuildable from the FTS
    -- transcript / transcript.live.md if ever dropped.
    CREATE TABLE IF NOT EXISTS transcript_segments (
      meeting_id TEXT NOT NULL,
      seg_id     TEXT NOT NULL,
      PRIMARY KEY (meeting_id, seg_id)
    );
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/** Insert or replace the index row mirroring a Meeting's indexable fields. */
export function upsertMeetingRow(db: IndexDb, m: Meeting): void {
  db.prepare(
    `INSERT INTO meetings
       (id, title, platform, status, started_at, ended_at, created_at, updated_at)
     VALUES
       (@id, @title, @platform, @status, @startedAt, @endedAt, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       title      = excluded.title,
       platform   = excluded.platform,
       status     = excluded.status,
       started_at = excluded.started_at,
       ended_at   = excluded.ended_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).run({
    id: m.id,
    title: m.title,
    platform: m.platform,
    status: m.status,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  });

  // Keep the FTS title in sync on every upsert. Transcript/summary are owned by
  // later PRDs (left as-is here when only the title changes).
  upsertSearchText(db, { meetingId: m.id, title: m.title });
}

/**
 * Searchable-text payload for a meeting. All text fields are optional so that
 * a producer can update just one column (e.g. append transcript) without
 * clobbering the others.
 */
export interface SearchText {
  meetingId: string;
  title?: string;
  transcript?: string;
  summary?: string;
}

/**
 * Upsert a meeting's full-text-searchable text into `meetings_fts`.
 *
 * STUB scope: title is wired now; transcript/summary are populated by later
 * PRDs (transcription / summaries). FTS5 rows have no rowid PK we control, so
 * "upsert" = delete existing rows for this meeting + insert a merged row. Only
 * the fields provided in `text` overwrite; omitted fields preserve whatever was
 * previously indexed for this meeting.
 */
export function upsertSearchText(db: IndexDb, text: SearchText): void {
  const existing = db
    .prepare(
      `SELECT title, transcript, summary FROM meetings_fts WHERE meeting_id = ?`,
    )
    .get(text.meetingId) as
    | { title: string; transcript: string; summary: string }
    | undefined;

  const merged = {
    title: text.title ?? existing?.title ?? "",
    transcript: text.transcript ?? existing?.transcript ?? "",
    summary: text.summary ?? existing?.summary ?? "",
  };

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM meetings_fts WHERE meeting_id = ?`).run(
      text.meetingId,
    );
    db.prepare(
      `INSERT INTO meetings_fts (meeting_id, title, transcript, summary)
       VALUES (?, ?, ?, ?)`,
    ).run(text.meetingId, merged.title, merged.transcript, merged.summary);
  });
  tx();
}

/**
 * Append one confirmed transcript segment's text to a meeting's FTS-indexed
 * transcript (PRD-3). Idempotent per (meeting, segId): the same segId appended
 * twice (e.g. a redelivered notification) does NOT duplicate text. We track the
 * set of already-indexed segIds per meeting in a small side table so re-runs are
 * cheap and the FTS transcript column stays the concatenation of distinct
 * finals' text in arrival order.
 *
 * This is the ONLY transcript-indexing entry point the lifecycle/transcript-
 * writer unit uses; it preserves whatever title/summary are already indexed.
 */
export function appendTranscriptText(
  db: IndexDb,
  meetingId: string,
  segId: string,
  text: string,
): void {
  const tx = db.transaction(() => {
    // Dedupe by (meeting, segId). INSERT OR IGNORE returns changes()===0 when
    // the segId was already indexed, in which case we skip the FTS append.
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO transcript_segments (meeting_id, seg_id) VALUES (?, ?)`,
      )
      .run(meetingId, segId);
    if (res.changes === 0) return;

    const existing = db
      .prepare(
        `SELECT title, transcript, summary FROM meetings_fts WHERE meeting_id = ?`,
      )
      .get(meetingId) as
      | { title: string; transcript: string; summary: string }
      | undefined;

    const prior = existing?.transcript ?? "";
    const merged = {
      title: existing?.title ?? "",
      transcript: prior ? `${prior} ${text}` : text,
      summary: existing?.summary ?? "",
    };
    db.prepare(`DELETE FROM meetings_fts WHERE meeting_id = ?`).run(meetingId);
    db.prepare(
      `INSERT INTO meetings_fts (meeting_id, title, transcript, summary)
       VALUES (?, ?, ?, ?)`,
    ).run(meetingId, merged.title, merged.transcript, merged.summary);
  });
  tx();
}

/** One full-text search hit row: meeting id + a highlighted snippet. */
export interface SearchHitRow {
  meetingId: string;
  snippet: string;
}

/**
 * Full-text search across indexed title + transcript, newest-first, returning
 * each matched meeting id with an FTS5 `snippet()` excerpt. The query is matched
 * as a literal phrase ({@link ftsPhrase}) so user input never throws an FTS5
 * syntax error. `limit` caps results (default 50).
 */
export function searchMeetingsFts(
  db: IndexDb,
  query: string,
  limit = 50,
): SearchHitRow[] {
  const q = ftsPhrase(query);
  // snippet(<table>, <colIndex>, <open>, <close>, <ellipsis>, <tokens>).
  // Column index 2 = transcript (0=meeting_id UNINDEXED, 1=title, 2=transcript).
  const rows = db
    .prepare(
      `SELECT f.meeting_id AS meetingId,
              snippet(meetings_fts, 2, '[', ']', '…', 12) AS snippet
       FROM meetings_fts f
       JOIN meetings m ON m.id = f.meeting_id
       WHERE meetings_fts MATCH @q
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT @limit`,
    )
    .all({ q, limit }) as Array<{ meetingId: string; snippet: string | null }>;
  return rows.map((r) => ({ meetingId: r.meetingId, snippet: r.snippet ?? "" }));
}

/** Remove a meeting's index + FTS rows. */
export function deleteMeetingRow(db: IndexDb, id: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM meetings_fts WHERE meeting_id = ?`).run(id);
    db.prepare(`DELETE FROM transcript_segments WHERE meeting_id = ?`).run(id);
  });
  tx();
}

/**
 * Escape an arbitrary user string into a single FTS5 phrase query. Wrapping in
 * double quotes (and doubling embedded quotes) turns operators, hyphens, and
 * other syntax into a literal phrase so a title query like `q-3 "release"` does
 * not throw an FTS5 syntax error.
 */
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}
