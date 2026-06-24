/**
 * @loqui/mcp-server — the server CORE (PRD-7).
 *
 * Two concrete pieces the Build phase fills against the Foundation contract:
 *
 *   1. {@link createReadStore} — the STRICTLY READ-ONLY {@link ReadStore} over
 *      `<dataRoot>/index.db` (opened in SQLite **readonly** mode) + the per-meeting
 *      files under `<dataRoot>/meetings/<id>/`. It runs the SAME shared read
 *      SQL/helpers ({@link queryMeetingIds}/{@link searchMeetingIds}) the app's
 *      writer store runs, so the reader can never drift from the writer schema.
 *      better-sqlite3 lives HERE (not in @loqui/shared, which stays driver-free).
 *
 *   2. {@link createMcpServer} — constructs an MCP {@link McpServer}, registers
 *      exactly the 5 read-only tools (see ./tools), and connects it over the
 *      chosen transport (`stdio` by default; optional loopback Streamable-HTTP
 *      bound to 127.0.0.1). Returns a {@link McpServerHandle} whose `stop()`
 *      tears down the transport AND closes the readonly db.
 *
 * STRICTLY READ-ONLY (asserted in tests):
 *   - The SQLite handle is opened with `{ readonly: true }`, and the file layer
 *     only ever `readFileSync`s — there is NO write/append/delete code path here.
 *   - The {@link ReadStore} interface has no mutator method.
 *   - The registered tool set is exactly {@link MCP_TOOL_NAMES}; none mutates.
 *   - Any HTTP transport binds {@link MCP_HTTP_HOST} (127.0.0.1) only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DATA_DIR_ENV,
  DEFAULT_DATA_DIR_NAME,
  INDEX_DB_NAME,
  MEETINGS_DIR_NAME,
  MEETING_DIARIZED_TRANSCRIPT_MD_FILE,
  MEETING_LIVE_TRANSCRIPT_FILE,
  MEETING_META_FILE,
  MEETING_SUMMARY_FILE,
  MEETING_TRANSCRIPT_FILE,
  MEETING_DIARIZED_TRANSCRIPT_JSON_FILE,
  MCP_HTTP_HOST,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  diarizedTranscriptSchema,
  mcpServerOptionsSchema,
  meetingSchema,
  queryMeetingIds,
  searchMeetingIds,
  summarySchema,
  type CreateMcpServer,
  type CreateReadStore,
  type DiarizedTranscript,
  type McpServerHandle,
  type McpServerOptions,
  type Meeting,
  type ReadListMeetingsOptions,
  type ReadSearchHit,
  type ReadStore,
  type ReadTranscriptVariant,
  type SqliteReadHandle,
  type Summary,
} from "@loqui/shared";
import { registerReadOnlyTools } from "./tools/index.js";
import { startHttpTransport } from "./http.js";

// --- data-root resolution (mirrors apps/desktop store/paths.ts) ---------------

/**
 * Resolve the data root the SAME way the app does: `LOQUI_DATA_DIR` when set
 * non-empty, else `~/Loqui`. Honored so the standalone bin serves the exact
 * store the app writes (tests point this at a temp dir).
 */
export function resolveDataRoot(dataRoot?: string): string {
  if (dataRoot && dataRoot.trim() !== "") return dataRoot;
  const override = process.env[DATA_DIR_ENV];
  if (override && override.trim() !== "") return override;
  return join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/**
 * A meeting id must be a safe path segment (no separators/traversal/NUL). The
 * tools pass ids that came from list/search (always safe UUIDs), but get_* take
 * arbitrary caller strings, so we guard here to keep an adversarial id from
 * escaping the meetings dir. Mirrors the app store's `assertSafeId`.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
function isSafeId(id: string): boolean {
  return typeof id === "string" && SAFE_ID.test(id) && id !== "." && id !== "..";
}

// --- the concrete READ-ONLY store ---------------------------------------------

/** Read a UTF-8 file, returning null on ENOENT (never throws on absence). */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

class ReadOnlyStore implements ReadStore {
  readonly #db: Database.Database;
  readonly #meetingsDir: string;

  constructor(db: Database.Database, meetingsDir: string) {
    this.#db = db;
    this.#meetingsDir = meetingsDir;
  }

  /** `<dataRoot>/meetings/<id>` — only ever called with a safe id. */
  #meetingDir(id: string): string {
    return join(this.#meetingsDir, id);
  }

  /** Parse one meeting's meta.json (source of truth) or null if absent/corrupt. */
  #readMeta(id: string): Meeting | null {
    if (!isSafeId(id)) return null;
    const raw = readFileOrNull(join(this.#meetingDir(id), MEETING_META_FILE));
    if (raw === null) return null;
    try {
      return meetingSchema.parse(JSON.parse(raw));
    } catch {
      // A corrupt meta.json must not crash the read surface (it just vanishes
      // from results) — the writer is the only thing that can fix it.
      return null;
    }
  }

  /** The minimal read handle the shared SELECT-only helpers run against. */
  get #handle(): SqliteReadHandle {
    return this.#db as unknown as SqliteReadHandle;
  }

  listMeetings(opts: ReadListMeetingsOptions = {}): Meeting[] {
    const ids = queryMeetingIds(this.#handle, opts);
    const out: Meeting[] = [];
    for (const id of ids) {
      const m = this.#readMeta(id);
      if (m) out.push(m);
    }
    return out;
  }

  searchMeetings(query: string, limit?: number): ReadSearchHit[] {
    if (query.trim() === "") return [];
    const hits = searchMeetingIds(this.#handle, query, limit);
    const out: ReadSearchHit[] = [];
    for (const hit of hits) {
      const meeting = this.#readMeta(hit.meetingId);
      if (meeting) out.push({ meeting, snippet: hit.snippet });
    }
    return out;
  }

  getMeeting(id: string): Meeting | null {
    return this.#readMeta(id);
  }

  getTranscript(id: string, variant: ReadTranscriptVariant = "live"): string {
    if (!isSafeId(id)) return "";
    const dir = this.#meetingDir(id);
    if (variant === "diarized") {
      // Diarized markdown when present, else gracefully fall back to live.
      const diarized = readFileOrNull(join(dir, MEETING_DIARIZED_TRANSCRIPT_MD_FILE));
      if (diarized !== null) return diarized;
      return readFileOrNull(join(dir, MEETING_LIVE_TRANSCRIPT_FILE)) ?? "";
    }
    const file =
      variant === "structured" ? MEETING_TRANSCRIPT_FILE : MEETING_LIVE_TRANSCRIPT_FILE;
    return readFileOrNull(join(dir, file)) ?? "";
  }

  getDiarizedTranscript(id: string): DiarizedTranscript | null {
    if (!isSafeId(id)) return null;
    const raw = readFileOrNull(
      join(this.#meetingDir(id), MEETING_DIARIZED_TRANSCRIPT_JSON_FILE),
    );
    if (raw === null) return null;
    try {
      return diarizedTranscriptSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  getSummary(id: string): Summary | null {
    if (!isSafeId(id)) return null;
    const raw = readFileOrNull(join(this.#meetingDir(id), MEETING_SUMMARY_FILE));
    if (raw === null) return null;
    try {
      return summarySchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Open the read-only store rooted at `dataRoot` (env-resolved when omitted).
 *
 * The SQLite index is opened with `{ readonly: true, fileMustExist: true }`:
 * readonly so the driver physically rejects writes, and fileMustExist so a
 * missing index.db surfaces as an error rather than silently creating an empty
 * db (the app, not the MCP server, owns creating the store).
 *
 * Implements the Foundation {@link CreateReadStore} signature.
 */
export const createReadStore: CreateReadStore = (dataRoot?: string): ReadStore => {
  const root = resolveDataRoot(dataRoot);
  const db = new Database(join(root, INDEX_DB_NAME), {
    readonly: true,
    fileMustExist: true,
  });
  return new ReadOnlyStore(db, join(root, MEETINGS_DIR_NAME));
};

// --- the MCP server ------------------------------------------------------------

/**
 * Build a configured {@link McpServer} (identity + the 5 read-only tools) over a
 * given {@link ReadStore}, WITHOUT connecting a transport. Exposed so tests can
 * register the tools against a seeded store and connect an in-memory transport
 * without spinning up stdio/http.
 */
export function buildLoquiMcpServer(store: ReadStore): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Loqui exposes the user's LOCAL meeting memory, READ-ONLY. Use " +
        "list_meetings to browse by date/title, search_meetings to full-text " +
        "search transcripts AND summaries (returns snippets + meeting ids), then " +
        "get_meeting / get_transcript / get_summary to fetch detail by id. No " +
        "tool can modify a meeting. Date inputs are ISO-8601; resolve natural " +
        "ranges (e.g. 'last Tuesday') to ISO bounds yourself.",
    },
  );
  registerReadOnlyTools(server, store);
  return server;
}

/**
 * Construct + start an MCP server over the chosen transport, backed by a fresh
 * read-only {@link ReadStore} on the resolved data root. Implements the
 * Foundation {@link CreateMcpServer} signature.
 *
 *   - `transport: "stdio"` (default): connects a {@link StdioServerTransport}
 *     (stdin/stdout is the protocol stream). `url` is null.
 *   - `transport: "http"`: delegates to {@link startHttpTransport} (the HTTP
 *     unit's loopback Streamable-HTTP/SSE helper), which binds
 *     {@link MCP_HTTP_HOST} (127.0.0.1 — never a public host) on `httpPort` and
 *     serves the MCP protocol. `url` is the bound loopback URL (with the
 *     OS-assigned port when port 0).
 *
 * `stop()` is idempotent: it disconnects the transport (and, for http, closes
 * the http listener) and closes the readonly db.
 */
export const createMcpServer: CreateMcpServer = async (
  options?: McpServerOptions,
): Promise<McpServerHandle> => {
  const opts = mcpServerOptionsSchema.parse(options ?? {});
  const store = createReadStore(opts.dataRoot);

  if (opts.transport === "http") {
    return startHttp(store, opts);
  }
  return startStdio(store);
};

/** stdio transport: connect the McpServer to stdin/stdout. */
async function startStdio(store: ReadStore): Promise<McpServerHandle> {
  const server = buildLoquiMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let stopped = false;
  return {
    transport: "stdio",
    url: null,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await server.close();
      store.close();
    },
  };
}

/**
 * Optional loopback Streamable-HTTP transport. Builds the same read-only server
 * (5 tools) and hands it to {@link startHttpTransport} (./http.ts), which binds
 * 127.0.0.1 ONLY (the literal-pinned host in the options schema + the helper's
 * own non-loopback refusal guarantee we never bind a public interface).
 */
async function startHttp(
  store: ReadStore,
  opts: { httpHost: typeof MCP_HTTP_HOST; httpPort: number },
): Promise<McpServerHandle> {
  const server = buildLoquiMcpServer(store);
  const http = await startHttpTransport(server, {
    host: opts.httpHost,
    port: opts.httpPort,
  });

  let stopped = false;
  return {
    transport: "http",
    url: http.url,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await http.close();
      await server.close();
      store.close();
    },
  };
}
