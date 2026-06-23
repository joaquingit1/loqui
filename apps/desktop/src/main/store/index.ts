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
import { mkdirSync } from "node:fs";
import {
  createMeetingInputSchema,
  meetingSchema,
  updateMeetingInputSchema,
  type CreateMeetingInput,
  type Meeting,
  type UpdateMeetingInput,
} from "@loqui/shared";
import {
  ftsPhrase,
  openIndexDb,
  upsertMeetingRow,
  upsertSearchText,
  type IndexDb,
  type SearchText,
} from "./db.js";
import { readMeta, writeMeta } from "./meta.js";
import { dataRoot, meetingsDir } from "./paths.js";

export {
  dataRoot,
  meetingsDir,
  indexDbPath,
  meetingDir,
  meetingMetaPath,
  meetingAudioDir,
} from "./paths.js";
export { upsertSearchText } from "./db.js";
export type { SearchText } from "./db.js";

export interface MeetingStore {
  /** Create a meeting: writes meta.json atomically + inserts the index row. */
  createMeeting(input?: CreateMeetingInput): Meeting;
  /** Read one meeting by id, or null if absent. */
  getMeeting(id: string): Meeting | null;
  /** List meetings, newest first. */
  listMeetings(opts?: ListMeetingsOptions): Meeting[];
  /** Patch a meeting; bumps updatedAt; rewrites meta.json atomically. */
  updateMeeting(id: string, patch: UpdateMeetingInput): Meeting;
  /** Index a meeting's searchable text (title now; transcript/summary later). */
  upsertSearchText(text: SearchText): void;
  /** Close the underlying SQLite handle. */
  close(): void;
}

/** Options for {@link MeetingStore.listMeetings}. */
export interface ListMeetingsOptions {
  /** Inclusive lower bound on `createdAt` (ISO 8601). */
  since?: string;
  /** Inclusive upper bound on `createdAt` (ISO 8601). */
  until?: string;
  /** Full-text title query (FTS5). Matched as a literal phrase. */
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

  upsertSearchText(text: SearchText): void {
    assertSafeId(text.meetingId);
    upsertSearchText(this.#db, text);
  }

  close(): void {
    this.#db.close();
  }

  /** Resolve the ordered list of meeting ids matching the list options. */
  #queryIds(opts: ListMeetingsOptions): string[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.since !== undefined) {
      where.push("m.created_at >= @since");
      params.since = opts.since;
    }
    if (opts.until !== undefined) {
      where.push("m.created_at <= @until");
      params.until = opts.until;
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
