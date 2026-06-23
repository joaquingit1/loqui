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
export const SCHEMA_VERSION = 1 as const;

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

/** Remove a meeting's index + FTS rows. */
export function deleteMeetingRow(db: IndexDb, id: string): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM meetings_fts WHERE meeting_id = ?`).run(id);
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
