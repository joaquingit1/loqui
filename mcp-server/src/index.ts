/**
 * @loqui/mcp-server — the local, STRICTLY READ-ONLY Model Context Protocol
 * server exposing Loqui's meeting store to the user's own agent (Claude Code /
 * Claude Desktop / Codex). PRD-7.
 *
 * This module is the package's public contract surface. Foundation re-exports the
 * shared seams (the ReadStore reader interface, the 5 tool input/output shapes,
 * the server/config/bin contract) so the Build phase implements AGAINST them
 * here and the desktop app + bin import ONE contract. The concrete
 * implementations (the better-sqlite3 readonly ReadStore, the MCP server factory
 * wiring the 5 tools onto a transport, the snippet generator) are filled in by
 * the Build phase in sibling files; their signatures are pinned below.
 *
 * READ-ONLY invariant (asserted in tests): the ReadStore has no write method, the
 * SQLite handle is opened readonly, and the registered tool set is exactly
 * {@link MCP_TOOL_NAMES} — none of which mutates a meeting.
 */
export {
  // Read-only store reader contract (shared single source of truth).
  type ReadStore,
  type ReadListMeetingsOptions,
  type ReadSearchHit,
  type ReadTranscriptVariant,
  type CreateReadStore,
  type SqliteReadHandle,
  type ReadStatement,
  STORE_INDEX,
  STORE_READ_SQL,
  queryMeetingIds,
  searchMeetingIds,
  ftsPhrase,
  toMeetingRef,
  // The 5 tool input/output shapes.
  MCP_TOOL_NAMES,
  type McpToolName,
  listMeetingsToolInputSchema,
  listMeetingsToolOutputSchema,
  searchMeetingsToolInputSchema,
  searchMeetingsToolOutputSchema,
  getMeetingToolInputSchema,
  getMeetingToolOutputSchema,
  getTranscriptToolInputSchema,
  getTranscriptToolOutputSchema,
  getSummaryToolInputSchema,
  getSummaryToolOutputSchema,
  // Server identity + transports + lifecycle + config-snippet contract.
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  LOQUI_MCP_BIN,
  MCP_TRANSPORTS,
  type McpTransport,
  MCP_HTTP_HOST,
  MCP_HTTP_DEFAULT_PORT,
  mcpServerOptionsSchema,
  type McpServerOptions,
  type McpServerHandle,
  type CreateMcpServer,
  type GenerateConfigSnippets,
  type McpConfigSnippet,
  type McpConfigInput,
  MCP_CONFIG_TARGETS,
  type McpConfigTarget,
} from "@loqui/shared";

// --- Build-phase concrete implementations (against the contract above) --------
//
// The read-only store opener + the MCP server factory live here (they import
// better-sqlite3 + the official MCP SDK, which @loqui/shared must not). The bin
// (src/bin/loqui-mcp.ts) and the app-managed lifecycle import `createMcpServer`
// from this package entrypoint; `createReadStore` is exported for anything that
// only needs the read store.
export {
  createReadStore,
  createMcpServer,
  buildLoquiMcpServer,
  resolveDataRoot,
} from "./server.js";
export { registerReadOnlyTools } from "./tools/index.js";
