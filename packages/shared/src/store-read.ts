/**
 * PRD-7 — the SHARED read-only store-reader contract.
 *
 * This is the single source of truth for the *read* surface over Loqui's data
 * root: the SQLite index (`<dataRoot>/index.db`) schema shape used by reads plus
 * the per-meeting file layout. BOTH the Electron app (its writer store) and the
 * read-only MCP server (PRD-7) type/query against THIS module so the MCP server
 * can never drift from the writer's schema.
 *
 * Why it lives in @loqui/shared: this package is the cross-process contract home
 * and already carries the layout constants + Meeting/Summary/DiarizedTranscript
 * schemas. We deliberately keep `better-sqlite3` OUT of @loqui/shared (it stays a
 * zod-only, environment-agnostic package): instead this module defines
 *
 *   1. The minimal {@link SqliteReadHandle} interface a caller adapts its
 *      better-sqlite3 handle to (only the prepared-statement reads we need).
 *   2. The canonical read SQL ({@link STORE_READ_SQL}) + table/column names
 *      ({@link STORE_INDEX}) the writer schema (apps/desktop store/db.ts) must
 *      match — asserted in tests on both sides.
 *   3. The pure query helpers ({@link queryMeetingIds}, {@link searchMeetingIds})
 *      that run that SQL against any {@link SqliteReadHandle}, returning ids +
 *      snippets (the file layer turns ids into full Meetings).
 *   4. The {@link ReadStore} interface (the 5-method read API the MCP tools call)
 *      + {@link createReadStore} factory SIGNATURE the Build phase implements in
 *      the mcp-server package (which owns the better-sqlite3 readonly open + the
 *      meta.json/transcript/summary file reads — using the SAME path helpers the
 *      app uses, re-exported from @loqui/shared layout constants).
 *
 * STRICTLY READ-ONLY: nothing here opens/declares a write. The SQL is SELECT
 * only; {@link SqliteReadHandle} exposes no write. The MCP server opens the db in
 * SQLite readonly mode (Build phase) so a write has no available code path.
 *
 * Build phase implements `createReadStore`; Foundation defines the types + SQL +
 * pure id/snippet query helpers (which are exercisable without a DB driver).
 */
import { z } from "zod";
import {
  summarySchema,
  type DiarizedTranscript,
  type Summary,
} from "./postprocess.js";
import { meetingSchema, type Meeting } from "./meeting.js";
import { TRANSCRIPT_VARIANTS } from "./constants.js";

// --- Canonical index schema names (mirror apps/desktop store/db.ts) -----------

/**
 * The index.db table + column names the READ path depends on. These mirror the
 * writer schema in apps/desktop/src/main/store/db.ts; a test on each side asserts
 * the live schema matches so a writer migration that renames these breaks loudly
 * rather than silently desyncing the MCP reader.
 */
export const STORE_INDEX = {
  meetingsTable: "meetings",
  ftsTable: "meetings_fts",
  /** FTS5 column ordinal of the `transcript` column (0=meeting_id,1=title,2=transcript,3=summary). */
  ftsTranscriptColumnIndex: 2,
  /** FTS5 column ordinal of the `summary` column (see ordering above). */
  ftsSummaryColumnIndex: 3,
} as const;

/**
 * The exact read-only SQL the shared query helpers run. Named so both sides
 * reference ONE string and a schema-drift test can diff against the live db.
 * `@from`/`@to`/`@q`/`@limit` are the only bound params.
 */
export const STORE_READ_SQL = {
  /** List meeting ids by optional createdAt range, newest-first. Caller appends WHERE/LIMIT. */
  listIdsBase: `SELECT m.id AS id FROM meetings m`,
  /** FTS match join used by both search + filtered-list. */
  searchJoin: `JOIN meetings_fts f ON f.meeting_id = m.id`,
  /** Newest-first ordering shared by list + search. */
  orderBy: `ORDER BY m.created_at DESC, m.id DESC`,
  /** snippet() over the transcript column for a search hit. */
  snippetExpr: `snippet(meetings_fts, 2, '[', ']', '…', 12)`,
  /**
   * snippet() over the summary column — the fallback when a hit matched ONLY
   * the summary (no transcript highlight), so summary-only hits still return a
   * citation-friendly excerpt instead of unrelated transcript text.
   */
  summarySnippetExpr: `snippet(meetings_fts, 3, '[', ']', '…', 12)`,
} as const;

/** The highlight markers {@link STORE_READ_SQL.snippetExpr} wraps a match in. */
export const SNIPPET_HIGHLIGHT_OPEN = "[";

// --- Minimal read-only SQLite handle the helpers run against -----------------

/** One prepared read statement: bind params, return all/one row. */
export interface ReadStatement {
  all(params?: Record<string, unknown>): unknown[];
  get(params?: Record<string, unknown>): unknown;
}

/**
 * The minimal surface the shared query helpers need from a SQLite driver. A
 * better-sqlite3 `Database` satisfies this structurally (its `.prepare` returns a
 * statement with `.all`/`.get`). Deliberately read-only: there is no `exec`/`run`
 * write method, so query code physically cannot mutate the index.
 */
export interface SqliteReadHandle {
  prepare(sql: string): ReadStatement;
}

/** Escape an arbitrary user string into a single literal FTS5 phrase query. */
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/** One full-text search hit row: meeting id + a highlighted snippet. */
export interface SearchHitRow {
  meetingId: string;
  snippet: string;
}

/**
 * Resolve the ordered list of meeting ids for a list query (date range +
 * optional FTS), newest-first. Pure over the handle: SELECT only. Signature
 * mirrors the app store's private `#queryIds`; Build phase reuses it on both
 * sides so list semantics can't diverge.
 */
export function queryMeetingIds(
  db: SqliteReadHandle,
  opts: { from?: string; to?: string; query?: string; limit?: number },
): string[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.from !== undefined) {
    where.push("m.created_at >= @from");
    params.from = opts.from;
  }
  if (opts.to !== undefined) {
    where.push("m.created_at <= @to");
    params.to = opts.to;
  }
  let sql: string;
  if (opts.query !== undefined && opts.query.trim() !== "") {
    params.q = ftsPhrase(opts.query);
    const clause = where.length ? `AND ${where.join(" AND ")}` : "";
    sql = `${STORE_READ_SQL.listIdsBase} ${STORE_READ_SQL.searchJoin} WHERE ${STORE_INDEX.ftsTable} MATCH @q ${clause} ${STORE_READ_SQL.orderBy}`;
  } else {
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    sql = `${STORE_READ_SQL.listIdsBase} ${clause} ${STORE_READ_SQL.orderBy}`;
  }
  if (opts.limit !== undefined) {
    sql += " LIMIT @limit";
    params.limit = opts.limit;
  }
  const rows = db.prepare(sql).all(params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Full-text search across indexed title + transcript + summary, newest-first,
 * returning each matched meeting id + an FTS5 snippet excerpt. `query` is matched
 * as a literal phrase so user input never throws an FTS5 syntax error.
 *
 * Snippet selection (PRD-7 AC#3 — usable snippets): we compute snippet() over
 * BOTH the transcript and summary columns and return the transcript snippet when
 * it actually highlighted the match; otherwise (a summary-only hit) we fall back
 * to the summary snippet so the excerpt cites where the query was found rather
 * than returning unrelated transcript text. Title-only hits keep the transcript
 * snippet (no highlight in either text column) — the meeting ref still carries
 * the matching title.
 */
export function searchMeetingIds(
  db: SqliteReadHandle,
  query: string,
  limit = 50,
): SearchHitRow[] {
  const q = ftsPhrase(query);
  const sql = `SELECT f.meeting_id AS meetingId, ${STORE_READ_SQL.snippetExpr} AS transcriptSnippet, ${STORE_READ_SQL.summarySnippetExpr} AS summarySnippet FROM ${STORE_INDEX.ftsTable} f JOIN ${STORE_INDEX.meetingsTable} m ON m.id = f.meeting_id WHERE ${STORE_INDEX.ftsTable} MATCH @q ${STORE_READ_SQL.orderBy} LIMIT @limit`;
  const rows = db.prepare(sql).all({ q, limit }) as Array<{
    meetingId: string;
    transcriptSnippet: string | null;
    summarySnippet: string | null;
  }>;
  return rows.map((r) => {
    const transcript = r.transcriptSnippet ?? "";
    const summary = r.summarySnippet ?? "";
    // Prefer the transcript snippet when it highlighted the match; otherwise use
    // the summary snippet for a summary-only hit (falling back to transcript so
    // we never return "" when transcript text exists).
    const snippet =
      transcript.includes(SNIPPET_HIGHLIGHT_OPEN) || !summary.includes(SNIPPET_HIGHLIGHT_OPEN)
        ? transcript
        : summary;
    return { meetingId: r.meetingId, snippet };
  });
}

// --- The read-only store interface the MCP tools call -------------------------

/**
 * Options for {@link ReadStore.listMeetings}. `from`/`to` are inclusive ISO-8601
 * bounds on a meeting's `createdAt`; `query` is an FTS phrase over title +
 * transcript + summary; `limit` caps rows. Newest-first.
 */
export interface ReadListMeetingsOptions {
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
}

/** One search hit: the full Meeting plus a highlighted snippet of the match. */
export interface ReadSearchHit {
  meeting: Meeting;
  snippet: string;
}

/** Which transcript variant a reader wants. Mirrors the app store. */
export type ReadTranscriptVariant = (typeof TRANSCRIPT_VARIANTS)[number] | "diarized";

/**
 * The READ-ONLY meeting store surface the MCP tools (and, optionally, anything
 * else that only reads) call. It is the read subset of the app's MeetingStore,
 * exposed so the MCP server depends on a contract — not on the desktop package.
 *
 * STRICTLY READ-ONLY: there is intentionally NO create/update/delete/append
 * method on this interface. A write attempt has no method to call (asserted in a
 * test). Every method reads files / the readonly db; none mutates.
 */
export interface ReadStore {
  /** List meetings newest-first, with optional date-range + FTS filter. */
  listMeetings(opts?: ReadListMeetingsOptions): Meeting[];
  /** FTS across title + transcript + summary; hits newest-first with snippets. */
  searchMeetings(query: string, limit?: number): ReadSearchHit[];
  /** One meeting's metadata by id, or null if absent. */
  getMeeting(id: string): Meeting | null;
  /**
   * A meeting's transcript text for the requested variant. `"diarized"` returns
   * the diarized markdown when present, else falls back to `"live"`. `""` when
   * no transcript file exists yet.
   */
  getTranscript(id: string, variant?: ReadTranscriptVariant): string;
  /** A meeting's diarized transcript JSON, or null if not yet diarized. */
  getDiarizedTranscript(id: string): DiarizedTranscript | null;
  /** A meeting's AI summary, or null if not yet generated. */
  getSummary(id: string): Summary | null;
  /** Close the underlying readonly SQLite handle. */
  close(): void;
}

/**
 * Factory SIGNATURE the Build phase implements in the mcp-server package. It
 * opens `<dataRoot>/index.db` in SQLite **readonly** mode and reads the
 * meta.json/transcript/summary files under `<dataRoot>/meetings/<id>/` using the
 * shared layout constants. `dataRoot` defaults to the env-resolved data root
 * (LOQUI_DATA_DIR else ~/Loqui) when omitted.
 *
 * NOTE: this is only the type. The implementation (which imports better-sqlite3)
 * lives in mcp-server so @loqui/shared stays driver-free.
 */
export type CreateReadStore = (dataRoot?: string) => ReadStore;

// --- The 5 MCP tool input/output zod shapes -----------------------------------
//
// Tight, well-described schemas: the agent picks tools from these. Inputs are
// validated by the server; outputs are compact + citation-friendly (ids +
// timestamps) so the agent can fetch detail with a follow-up tool call. Dates
// are ISO-8601; natural ranges ("last Tuesday") are resolved by the CALLER into
// these ISO bounds (documented).

/** Compact meeting reference returned in list/search results (not the full record). */
export const meetingRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  /** Meeting start (ISO-8601) when known, else null. */
  startedAt: z.string().nullable(),
  /** createdAt (ISO-8601) — the field list/search order + range filter on. */
  createdAt: z.string(),
});
export type MeetingRef = z.infer<typeof meetingRefSchema>;

/** Input: `list_meetings`. */
export const listMeetingsToolInputSchema = z.object({
  from: z.string().optional().describe("Inclusive lower bound on createdAt (ISO-8601)."),
  to: z.string().optional().describe("Inclusive upper bound on createdAt (ISO-8601)."),
  query: z
    .string()
    .optional()
    .describe("Optional full-text match over title, transcript and summary."),
  limit: z.number().int().positive().max(200).optional().describe("Max rows (default 50)."),
});
export type ListMeetingsToolInput = z.infer<typeof listMeetingsToolInputSchema>;

/** Output: `list_meetings` — meeting refs, newest-first. */
export const listMeetingsToolOutputSchema = z.object({
  meetings: z.array(meetingRefSchema),
});
export type ListMeetingsToolOutput = z.infer<typeof listMeetingsToolOutputSchema>;

/** Input: `search_meetings`. */
export const searchMeetingsToolInputSchema = z.object({
  query: z.string().min(1).describe("Full-text query across transcripts AND summaries."),
  limit: z.number().int().positive().max(200).optional().describe("Max hits (default 50)."),
});
export type SearchMeetingsToolInput = z.infer<typeof searchMeetingsToolInputSchema>;

/** One search hit: a meeting ref + a highlighted snippet. */
export const searchHitSchema = z.object({
  meeting: meetingRefSchema,
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

/** Output: `search_meetings`. */
export const searchMeetingsToolOutputSchema = z.object({
  hits: z.array(searchHitSchema),
});
export type SearchMeetingsToolOutput = z.infer<typeof searchMeetingsToolOutputSchema>;

/** Input: `get_meeting`. */
export const getMeetingToolInputSchema = z.object({
  id: z.string().describe("Meeting id (from list/search results)."),
});
export type GetMeetingToolInput = z.infer<typeof getMeetingToolInputSchema>;

/** Output: `get_meeting` — the full meeting metadata, or null when absent. */
export const getMeetingToolOutputSchema = z.object({
  meeting: meetingSchema.nullable(),
});
export type GetMeetingToolOutput = z.infer<typeof getMeetingToolOutputSchema>;

/** The transcript variant an agent may request. */
export const mcpTranscriptVariantSchema = z
  .enum(["live", "diarized"])
  .default("diarized")
  .describe("'diarized' (speaker-labeled, falls back to live) or 'live' raw transcript.");

/** Input: `get_transcript`. */
export const getTranscriptToolInputSchema = z.object({
  id: z.string().describe("Meeting id."),
  variant: mcpTranscriptVariantSchema.optional(),
});
export type GetTranscriptToolInput = z.infer<typeof getTranscriptToolInputSchema>;

/** Output: `get_transcript`. `text` is "" when no transcript exists yet. */
export const getTranscriptToolOutputSchema = z.object({
  id: z.string(),
  variant: z.enum(["live", "diarized"]),
  text: z.string(),
});
export type GetTranscriptToolOutput = z.infer<typeof getTranscriptToolOutputSchema>;

/** Input: `get_summary`. */
export const getSummaryToolInputSchema = z.object({
  id: z.string().describe("Meeting id."),
});
export type GetSummaryToolInput = z.infer<typeof getSummaryToolInputSchema>;

/** Output: `get_summary` — the structured summary, or null when not generated. */
export const getSummaryToolOutputSchema = z.object({
  summary: summarySchema.nullable(),
});
export type GetSummaryToolOutput = z.infer<typeof getSummaryToolOutputSchema>;

/** The 5 read-only MCP tool names. No tool can modify a meeting. */
export const MCP_TOOL_NAMES = [
  "list_meetings",
  "search_meetings",
  "get_meeting",
  "get_transcript",
  "get_summary",
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Project a full Meeting down to the compact {@link MeetingRef} list/search shape. */
export function toMeetingRef(m: Meeting): MeetingRef {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    startedAt: m.startedAt,
    createdAt: m.createdAt,
  };
}
