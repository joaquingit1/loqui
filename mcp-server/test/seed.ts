/**
 * Hermetic store seeding for the mcp-server tests.
 *
 * Builds a temp data root that looks EXACTLY like one the app's writer store
 * produced: an `index.db` whose schema mirrors apps/desktop store/db.ts (the
 * meetings table + the standalone `meetings_fts` FTS5 table with the SAME column
 * order the shared read SQL assumes: meeting_id, title, transcript, summary) plus
 * per-meeting files (meta.json, transcript.live.md, transcript.diarized.md,
 * summary.json). The MCP read store + tools then run against this with NOTHING
 * mocked — same files, same db schema, same shared read helpers.
 *
 * No network; everything is under an os.tmpdir() dir keyed by LOQUI_DATA_DIR.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  INDEX_DB_NAME,
  MEETINGS_DIR_NAME,
  MEETING_DIARIZED_TRANSCRIPT_JSON_FILE,
  MEETING_DIARIZED_TRANSCRIPT_MD_FILE,
  MEETING_LIVE_TRANSCRIPT_FILE,
  MEETING_META_FILE,
  MEETING_SUMMARY_FILE,
  meetingSchema,
  type DiarizedTranscript,
  type Meeting,
  type Summary,
} from "@loqui/shared";

/** A single meeting to seed: its meta + optional transcript/summary files. */
export interface SeedMeeting {
  meeting: Meeting;
  /** FTS-indexed transcript text (what search hits + snippets come from). */
  ftsTranscript?: string;
  /** FTS-indexed summary text. */
  ftsSummary?: string;
  /** transcript.live.md file body. */
  liveTranscript?: string;
  /** transcript.diarized.md file body. */
  diarizedTranscriptMd?: string;
  /** transcript.diarized.json document. */
  diarizedTranscriptJson?: DiarizedTranscript;
  /** summary.json document. */
  summary?: Summary;
}

export interface SeededStore {
  /** The temp data root (set this as LOQUI_DATA_DIR or pass to createReadStore). */
  dataRoot: string;
  /** Remove the temp dir. */
  cleanup(): void;
}

/** Build a fully-defaulted Meeting from a partial, via the shared schema. */
export function makeMeeting(partial: Partial<Meeting> & { id: string; createdAt: string }): Meeting {
  return meetingSchema.parse({
    title: "",
    status: "done",
    updatedAt: partial.createdAt,
    ...partial,
  });
}

/**
 * Create the on-disk store. Writes index.db (app schema) + meeting files. Mirrors
 * the writer's FTS upsert (delete-then-insert a merged row keyed by meeting_id).
 */
export function seedStore(meetings: SeedMeeting[]): SeededStore {
  const dataRoot = mkdtempSync(join(tmpdir(), "loqui-mcp-test-"));
  const meetingsDir = join(dataRoot, MEETINGS_DIR_NAME);
  mkdirSync(meetingsDir, { recursive: true });

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

  const insertMeeting = db.prepare(
    `INSERT INTO meetings (id, title, platform, status, started_at, ended_at, created_at, updated_at)
     VALUES (@id, @title, @platform, @status, @startedAt, @endedAt, @createdAt, @updatedAt)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO meetings_fts (meeting_id, title, transcript, summary) VALUES (?, ?, ?, ?)`,
  );

  for (const s of meetings) {
    const m = s.meeting;
    insertMeeting.run({
      id: m.id,
      title: m.title,
      platform: m.platform,
      status: m.status,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    });
    insertFts.run(m.id, m.title, s.ftsTranscript ?? "", s.ftsSummary ?? "");

    const dir = join(meetingsDir, m.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MEETING_META_FILE), `${JSON.stringify(m, null, 2)}\n`, "utf8");
    if (s.liveTranscript !== undefined) {
      writeFileSync(join(dir, MEETING_LIVE_TRANSCRIPT_FILE), s.liveTranscript, "utf8");
    }
    if (s.diarizedTranscriptMd !== undefined) {
      writeFileSync(join(dir, MEETING_DIARIZED_TRANSCRIPT_MD_FILE), s.diarizedTranscriptMd, "utf8");
    }
    if (s.diarizedTranscriptJson !== undefined) {
      writeFileSync(
        join(dir, MEETING_DIARIZED_TRANSCRIPT_JSON_FILE),
        `${JSON.stringify(s.diarizedTranscriptJson, null, 2)}\n`,
        "utf8",
      );
    }
    if (s.summary !== undefined) {
      writeFileSync(join(dir, MEETING_SUMMARY_FILE), `${JSON.stringify(s.summary, null, 2)}\n`, "utf8");
    }
  }

  db.close();

  return {
    dataRoot,
    cleanup() {
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** An empty store (index.db with the schema, but zero meetings). */
export function seedEmptyStore(): SeededStore {
  return seedStore([]);
}
