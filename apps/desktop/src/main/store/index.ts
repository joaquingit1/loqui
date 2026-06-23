/**
 * The meeting store: the on-disk meta.json files (source of truth) plus the
 * SQLite index that makes them listable/searchable.
 *
 * Import as: `import { type MeetingStore, openStore } from "../store/index.js"`
 *
 * Data root is resolved by ./paths.ts (honors LOQUI_DATA_DIR), so the store is
 * hermetic under test. Every read and write is validated against the shared
 * zod `meetingSchema`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import {
  createMeetingInputSchema,
  meetingSchema,
  updateMeetingInputSchema,
  type CreateMeetingInput,
  type Meeting,
  type MeetingSearchHit,
  type TranscriptVariant,
  type UpdateMeetingInput,
} from "@loqui/shared";
import {
  appendTranscriptText,
  ftsPhrase,
  openIndexDb,
  searchMeetingsFts,
  upsertMeetingRow,
  upsertSearchText,
  type IndexDb,
  type SearchText,
} from "./db.js";
import { readMeta, writeMeta } from "./meta.js";
import { dataRoot, meetingsDir, meetingTranscriptPath } from "./paths.js";

export {
  dataRoot,
  meetingsDir,
  indexDbPath,
  meetingDir,
  meetingMetaPath,
  meetingAudioDir,
  meetingLiveTranscriptPath,
  meetingTranscriptPath,
} from "./paths.js";
export { upsertSearchText } from "./db.js";
export type { SearchText } from "./db.js";

export interface MeetingStore {
  /** Create a meeting: writes meta.json atomically + inserts the index row. */
  createMeeting(input?: CreateMeetingInput): Meeting;
  /** Read one meeting by id, or null if absent. */
  getMeeting(id: string): Meeting | null;
  /** List meetings, newest first, with optional date-range + full-text filter. */
  listMeetings(opts?: ListMeetingsOptions): Meeting[];
  /**
   * Full-text search across indexed title + transcript text; returns each
   * matched meeting (newest-first) with a highlighted snippet of the match.
   */
  searchMeetings(query: string, limit?: number): MeetingSearchHit[];
  /**
   * Read a meeting's transcript file for the requested variant (default
   * `"live"` = transcript.live.md). Returns "" when the file does not yet exist
   * (e.g. a meeting with no confirmed segments). READ-ONLY — never writes.
   */
  getTranscript(id: string, variant?: TranscriptVariant): string;
  /** Patch a meeting; bumps updatedAt; rewrites meta.json atomically. */
  updateMeeting(id: string, patch: UpdateMeetingInput): Meeting;
  /** Index a meeting's searchable text (title/summary; transcript via append). */
  upsertSearchText(text: SearchText): void;
  /**
   * Append ONE confirmed transcript segment's text into the FTS transcript
   * index, idempotently per (meeting, segId). This is the index half of the
   * transcript-writer path (the file half is the TranscriptWriter). Re-appending
   * the same segId is a no-op.
   */
  appendTranscriptSegment(meetingId: string, segId: string, text: string): void;
  /** Close the underlying SQLite handle. */
  close(): void;
}

/**
 * Options for {@link MeetingStore.listMeetings}.
 *
 * PRD-3 exposes `from`/`to` as the canonical inclusive `createdAt` bounds;
 * `since`/`until` are accepted as aliases for backward compatibility (PRD-0).
 * If both are given, `from`/`to` win.
 */
export interface ListMeetingsOptions {
  /** Inclusive lower bound on `createdAt` (ISO 8601). */
  from?: string;
  /** Inclusive upper bound on `createdAt` (ISO 8601). */
  to?: string;
  /** Deprecated alias for {@link ListMeetingsOptions.from}. */
  since?: string;
  /** Deprecated alias for {@link ListMeetingsOptions.to}. */
  until?: string;
  /** Full-text query over title + transcript (FTS5). Matched as a literal phrase. */
  query?: string;
  /** Max rows to return. */
  limit?: number;
}

/**
 * A meeting id must be a safe path segment: no separators, no traversal, no
 * NUL, not empty/dot. We canonically mint UUIDs, but `createMeeting` accepts no
 * id from callers and `getMeeting`/`updateMeeting` take arbitrary strings — so
 * we guard here to keep adversarial ids from escaping the meetings dir.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeId(id: string): void {
  if (typeof id !== "string" || !SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`store: invalid meeting id ${JSON.stringify(id)}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

class FsMeetingStore implements MeetingStore {
  readonly #db: IndexDb;

  constructor(db: IndexDb) {
    this.#db = db;
  }

  createMeeting(input?: CreateMeetingInput): Meeting {
    // Validate + default the caller-supplied fields (rejects an id/createdAt/
    // updatedAt sneak-in because the input schema omits them).
    const fields = createMeetingInputSchema.parse(input ?? {});
    const now = nowIso();
    const meeting: Meeting = meetingSchema.parse({
      ...fields,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });

    // meta.json is the source of truth — write it first (atomically), then
    // mirror into the index. If the index write fails, the on-disk file still
    // exists and a future rebuild/reopen will pick it up.
    writeMeta(meeting);
    upsertMeetingRow(this.#db, meeting);
    return meeting;
  }

  getMeeting(id: string): Meeting | null {
    assertSafeId(id);
    return readMeta(id);
  }

  listMeetings(opts: ListMeetingsOptions = {}): Meeting[] {
    const ids = this.#queryIds(opts);
    const out: Meeting[] = [];
    for (const id of ids) {
      // Read each meeting back from its meta.json (source of truth) so the
      // returned objects are fully-validated Meetings, not the index subset.
      const m = readMeta(id);
      if (m) out.push(m);
    }
    return out;
  }

  updateMeeting(id: string, patch: UpdateMeetingInput): Meeting {
    assertSafeId(id);
    const current = readMeta(id);
    if (!current) {
      throw new Error(`store: cannot update unknown meeting ${id}`);
    }
    const cleanPatch = updateMeetingInputSchema.parse(patch ?? {});
    const updated: Meeting = meetingSchema.parse({
      ...current,
      ...cleanPatch,
      // Immutable identity + creation; updatedAt always advances.
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    });
    writeMeta(updated);
    upsertMeetingRow(this.#db, updated);
    return updated;
  }

  searchMeetings(query: string, limit?: number): MeetingSearchHit[] {
    if (query.trim() === "") return [];
    const hits = searchMeetingsFts(this.#db, query, limit);
    const out: MeetingSearchHit[] = [];
    for (const hit of hits) {
      const meeting = readMeta(hit.meetingId);
      if (meeting) out.push({ meeting, snippet: hit.snippet });
    }
    return out;
  }

  getTranscript(id: string, variant: TranscriptVariant = "live"): string {
    assertSafeId(id);
    try {
      return readFileSync(meetingTranscriptPath(id, variant), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }

  upsertSearchText(text: SearchText): void {
    assertSafeId(text.meetingId);
    upsertSearchText(this.#db, text);
  }

  appendTranscriptSegment(meetingId: string, segId: string, text: string): void {
    assertSafeId(meetingId);
    appendTranscriptText(this.#db, meetingId, segId, text);
  }

  close(): void {
    this.#db.close();
  }

  /** Resolve the ordered list of meeting ids matching the list options. */
  #queryIds(opts: ListMeetingsOptions): string[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    // `from`/`to` (PRD-3) are canonical; `since`/`until` (PRD-0) are aliases.
    const from = opts.from ?? opts.since;
    const to = opts.to ?? opts.until;
    if (from !== undefined) {
      where.push("m.created_at >= @from");
      params.from = from;
    }
    if (to !== undefined) {
      where.push("m.created_at <= @to");
      params.to = to;
    }

    let sql: string;
    if (opts.query !== undefined && opts.query.trim() !== "") {
      params.q = ftsPhrase(opts.query);
      const clause = where.length ? `AND ${where.join(" AND ")}` : "";
      sql = `
        SELECT m.id AS id
        FROM meetings m
        JOIN meetings_fts f ON f.meeting_id = m.id
        WHERE meetings_fts MATCH @q ${clause}
        ORDER BY m.created_at DESC, m.id DESC
      `;
    } else {
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      sql = `
        SELECT m.id AS id
        FROM meetings m
        ${clause}
        ORDER BY m.created_at DESC, m.id DESC
      `;
    }

    if (opts.limit !== undefined) {
      sql += " LIMIT @limit";
      params.limit = opts.limit;
    }

    const rows = this.#db.prepare(sql).all(params) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}

/**
 * Open (creating if needed) the store rooted at the resolved data dir. Ensures
 * the data root, meetings dir, and SQLite index all exist.
 */
export function openStore(): MeetingStore {
  // Ensure the directory layout exists before opening the index.
  mkdirSync(dataRoot(), { recursive: true });
  mkdirSync(meetingsDir(), { recursive: true });
  const db = openIndexDb();
  return new FsMeetingStore(db);
}
