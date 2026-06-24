/**
 * The 5 READ-ONLY MCP tools (PRD-7), registered onto an {@link McpServer} over a
 * read-only {@link ReadStore}. The agent picks tools by their descriptions, so
 * each is tight + well-described and returns compact, citation-friendly output
 * (ids + ISO timestamps) so the agent can fetch detail with a follow-up call.
 *
 * STRICTLY READ-ONLY: every tool only reads (the store has no mutator); the
 * registered set is EXACTLY {@link MCP_TOOL_NAMES} — there is no write/edit/
 * delete tool, and adding one would require a new name not in that list (asserted
 * in a test). Each tool publishes `annotations.readOnlyHint = true`.
 *
 * Output transport convention: when a tool declares an `outputSchema`, the SDK
 * expects `structuredContent`. We return BOTH a `structuredContent` object (for
 * structured-aware clients) AND a `content` text block of the same JSON (so
 * text-only clients still see the result).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MCP_TOOL_NAMES,
  getMeetingToolInputSchema,
  getMeetingToolOutputSchema,
  getSummaryToolInputSchema,
  getSummaryToolOutputSchema,
  getTranscriptToolInputSchema,
  getTranscriptToolOutputSchema,
  listMeetingsToolInputSchema,
  listMeetingsToolOutputSchema,
  searchMeetingsToolInputSchema,
  searchMeetingsToolOutputSchema,
  toMeetingRef,
  type GetMeetingToolOutput,
  type GetSummaryToolOutput,
  type GetTranscriptToolOutput,
  type ListMeetingsToolOutput,
  type ReadStore,
  type SearchMeetingsToolOutput,
} from "@loqui/shared";

/** Read-only annotation set the agent + host can rely on for every tool. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Wrap a structured tool result into the MCP call result shape: a JSON text
 * block (for text-only clients) PLUS the `structuredContent` the declared
 * outputSchema validates against.
 */
function result(structured: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * Register the 5 read-only tools on `server`, each backed by `store`. Returns the
 * registered tool names (exactly {@link MCP_TOOL_NAMES}) so a caller/test can
 * assert the surface.
 */
export function registerReadOnlyTools(
  server: McpServer,
  store: ReadStore,
): readonly string[] {
  // list_meetings ------------------------------------------------------------
  server.registerTool(
    "list_meetings",
    {
      title: "List meetings",
      description:
        "List the user's past meetings, most recent first. Optionally filter by " +
        "an inclusive createdAt date range (ISO-8601 'from'/'to') and/or a " +
        "full-text 'query' over meeting titles, transcripts and summaries. " +
        "Returns compact meeting refs " +
        "(id, title, status, startedAt, createdAt) — use get_meeting / " +
        "get_transcript / get_summary with an id to fetch detail.",
      inputSchema: listMeetingsToolInputSchema.shape,
      outputSchema: listMeetingsToolOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const meetings = store
        .listMeetings({
          from: args.from,
          to: args.to,
          query: args.query,
          limit: args.limit ?? 50,
        })
        .map(toMeetingRef);
      const out: ListMeetingsToolOutput = { meetings };
      return result(out);
    },
  );

  // search_meetings ----------------------------------------------------------
  server.registerTool(
    "search_meetings",
    {
      title: "Search meetings",
      description:
        "Full-text search across the user's meeting TRANSCRIPTS and SUMMARIES. " +
        "Returns hits most-recent-first, each with a compact meeting ref and a " +
        "highlighted snippet ([...] marks the match) of where the query appeared. " +
        "Use the returned meeting id with get_transcript / get_summary to read " +
        "the full content. Good for 'what did we decide about X' style questions.",
      inputSchema: searchMeetingsToolInputSchema.shape,
      outputSchema: searchMeetingsToolOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const hits = store.searchMeetings(args.query, args.limit ?? 50).map((h) => ({
        meeting: toMeetingRef(h.meeting),
        snippet: h.snippet,
      }));
      const out: SearchMeetingsToolOutput = { hits };
      return result(out);
    },
  );

  // get_meeting --------------------------------------------------------------
  server.registerTool(
    "get_meeting",
    {
      title: "Get meeting metadata",
      description:
        "Fetch one meeting's full metadata by id (from list_meetings / " +
        "search_meetings): title, platform, start/end times, status, participants " +
        "and speaker labels, and model versions. Returns null when no meeting has " +
        "that id. Read get_transcript / get_summary for the content itself.",
      inputSchema: getMeetingToolInputSchema.shape,
      outputSchema: getMeetingToolOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const out: GetMeetingToolOutput = { meeting: store.getMeeting(args.id) };
      return result(out);
    },
  );

  // get_transcript -----------------------------------------------------------
  server.registerTool(
    "get_transcript",
    {
      title: "Get meeting transcript",
      description:
        "Fetch a meeting's transcript text by id. variant 'diarized' (the " +
        "default) returns the speaker-labeled transcript when available and falls " +
        "back to the raw 'live' transcript otherwise; variant 'live' always " +
        "returns the raw transcript. 'text' is an empty string when the meeting " +
        "has no transcript yet.",
      inputSchema: getTranscriptToolInputSchema.shape,
      outputSchema: getTranscriptToolOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const variant = args.variant ?? "diarized";
      const text = store.getTranscript(args.id, variant);
      const out: GetTranscriptToolOutput = { id: args.id, variant, text };
      return result(out);
    },
  );

  // get_summary --------------------------------------------------------------
  server.registerTool(
    "get_summary",
    {
      title: "Get meeting summary",
      description:
        "Fetch a meeting's AI-generated summary by id: a TL;DR, key decisions, " +
        "action items (with owners when inferable), and topics. Returns null when " +
        "no summary has been generated for the meeting yet.",
      inputSchema: getSummaryToolInputSchema.shape,
      outputSchema: getSummaryToolOutputSchema.shape,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (args) => {
      const out: GetSummaryToolOutput = { summary: store.getSummary(args.id) };
      return result(out);
    },
  );

  return MCP_TOOL_NAMES;
}
