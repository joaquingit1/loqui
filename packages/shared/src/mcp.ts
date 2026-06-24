/**
 * PRD-7 — shared MCP server contract seams.
 *
 * The MCP-specific contract types that BOTH the desktop app (for the app-managed
 * lifecycle + the printed config snippets in Settings) and the mcp-server package
 * (the actual server + bin) type against. Kept in @loqui/shared so the IPC
 * status/config shapes and the snippet generator have ONE definition.
 *
 * STRICTLY READ-ONLY server (see ./store-read.ts ReadStore): this module only
 * describes the server identity, transports, lifecycle status, and the
 * agent-config snippets — none of which can write a meeting.
 */
import { z } from "zod";

/** The MCP server's advertised name + version (sent in the MCP initialize handshake). */
export const MCP_SERVER_NAME = "loqui" as const;
export const MCP_SERVER_VERSION = "0.1.0" as const;

/** Standalone bin name a user adds to their agent config. */
export const LOQUI_MCP_BIN = "loqui-mcp" as const;

/**
 * Transports the server can serve. `stdio` is primary (what agent configs point
 * at). `http` is an OPTIONAL loopback-only Streamable-HTTP/SSE transport bound to
 * 127.0.0.1 — never a non-loopback host.
 */
export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** Loopback host the optional HTTP transport MUST bind to. Never a public host. */
export const MCP_HTTP_HOST = "127.0.0.1" as const;
/** Default loopback port for the optional HTTP transport (0 = OS-assigned). */
export const MCP_HTTP_DEFAULT_PORT = 7333 as const;

/**
 * Options to start an MCP server instance (the server factory input). All
 * optional + defaulted: `transport` defaults to `"stdio"`; `dataRoot` defaults to
 * the env-resolved root (LOQUI_DATA_DIR else ~/Loqui); `httpHost` is pinned to
 * loopback; `httpPort` applies only to the http transport.
 */
export const mcpServerOptionsSchema = z.object({
  transport: z.enum(MCP_TRANSPORTS).default("stdio"),
  dataRoot: z.string().optional(),
  httpHost: z.literal(MCP_HTTP_HOST).default(MCP_HTTP_HOST),
  httpPort: z.number().int().nonnegative().default(MCP_HTTP_DEFAULT_PORT),
});
export type McpServerOptions = z.input<typeof mcpServerOptionsSchema>;

/**
 * App-managed lifecycle status (main -> renderer for the Settings indicator).
 * `running` is whether the app-managed server process is up; `transport`/`url`
 * describe how it's reachable (url null for stdio); `dataRoot` is the root it
 * serves; `pid` is the managed child pid when running.
 */
export const mcpStatusSchema = z.object({
  running: z.boolean().default(false),
  transport: z.enum(MCP_TRANSPORTS).default("stdio"),
  /** Loopback URL when serving http; null for stdio / when stopped. */
  url: z.string().nullable().default(null),
  dataRoot: z.string().default(""),
  pid: z.number().int().nullable().default(null),
});
export type McpStatus = z.infer<typeof mcpStatusSchema>;

/** The agents we print ready-to-paste config snippets for in Settings. */
export const MCP_CONFIG_TARGETS = ["claude-code", "claude-desktop", "codex"] as const;
export type McpConfigTarget = (typeof MCP_CONFIG_TARGETS)[number];

/**
 * One ready-to-paste config snippet for an agent. `target` is the agent;
 * `label` is a human title ("Claude Code"); `language` hints the code block
 * (`bash`/`json`/`toml`); `content` is the literal snippet to copy.
 */
export const mcpConfigSnippetSchema = z.object({
  target: z.enum(MCP_CONFIG_TARGETS),
  label: z.string(),
  language: z.enum(["bash", "json", "toml"]),
  content: z.string(),
});
export type McpConfigSnippet = z.infer<typeof mcpConfigSnippetSchema>;

/**
 * Inputs the snippet generator needs to render the snippets: the resolved
 * `binPath` (absolute path to the `loqui-mcp` bin the app ships, or just the bin
 * name for a globally-installed standalone) and the `dataRoot` the server should
 * serve (passed via LOQUI_DATA_DIR in the snippet so it matches the app).
 */
export const mcpConfigInputSchema = z.object({
  binPath: z.string().default(LOQUI_MCP_BIN),
  dataRoot: z.string().optional(),
});
export type McpConfigInput = z.infer<typeof mcpConfigInputSchema>;

/**
 * SIGNATURE the Build phase implements: render the ready-to-paste config
 * snippets (one per {@link MCP_CONFIG_TARGETS}) for the standalone stdio server.
 * Pure (no I/O) — it formats strings from the input. Lives in mcp-server (shared
 * with the app via this signature) so Settings + docs use ONE generator.
 */
export type GenerateConfigSnippets = (input?: McpConfigInput) => McpConfigSnippet[];

/**
 * SIGNATURE the Build phase implements (in mcp-server): construct + start an MCP
 * server over the chosen transport, backed by a read-only {@link import(
 * "./store-read.js").ReadStore}. Returns a handle to stop it + (for http) the
 * bound loopback url. Registers exactly the 5 read-only tools — no write tool.
 */
export interface McpServerHandle {
  /** The transport this instance is serving. */
  transport: McpTransport;
  /** Loopback url when serving http; null for stdio. */
  url: string | null;
  /** Stop the server + release the transport + close the ReadStore. Idempotent. */
  stop(): Promise<void>;
}
export type CreateMcpServer = (options?: McpServerOptions) => Promise<McpServerHandle>;
