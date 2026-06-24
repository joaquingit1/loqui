/**
 * Ready-to-paste MCP config snippets (PRD-7, main side).
 *
 * Pure string formatting — NO I/O. Renders one copy-paste snippet per agent
 * ({@link MCP_CONFIG_TARGETS}: Claude Code / Claude Desktop / Codex) that points
 * the agent at the LOCAL standalone `loqui-mcp` bin over stdio. The bin reads the
 * same meeting store the app uses (LOQUI_DATA_DIR) and is STRICTLY READ-ONLY.
 *
 * Implements the shared {@link GenerateConfigSnippets} signature here (not via
 * the mcp-server package) so the app's Settings IPC is self-contained: it depends
 * only on @loqui/shared contract constants, never on the mcp-server build output.
 * Both sides format identically because they consume the SAME contract constants
 * (MCP_SERVER_NAME / LOQUI_MCP_BIN / DATA_DIR_ENV).
 */
import {
  DATA_DIR_ENV,
  LOQUI_MCP_BIN,
  MCP_SERVER_NAME,
  mcpConfigInputSchema,
  type GenerateConfigSnippets,
  type McpConfigInput,
  type McpConfigSnippet,
} from "@loqui/shared";

/**
 * The JSON body shared by Claude Code (`.mcp.json` / JSON form) and Claude
 * Desktop (`claude_desktop_config.json`): an `mcpServers` map keyed by the
 * server name, each with the `command` + optional `env` (LOQUI_DATA_DIR) so the
 * agent serves the SAME data root the app does. stdio transport (no args).
 */
function mcpServersJson(binPath: string, dataRoot: string | undefined): string {
  const server: { command: string; args: string[]; env?: Record<string, string> } = {
    command: binPath,
    args: [],
  };
  if (dataRoot && dataRoot.trim() !== "") {
    server.env = { [DATA_DIR_ENV]: dataRoot };
  }
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2);
}

/** Bash `claude mcp add` one-liner (with `-e LOQUI_DATA_DIR=…` when set). */
function claudeCodeAddCommand(binPath: string, dataRoot: string | undefined): string {
  const envFlag =
    dataRoot && dataRoot.trim() !== "" ? `-e ${DATA_DIR_ENV}=${shellQuote(dataRoot)} ` : "";
  return `claude mcp add ${MCP_SERVER_NAME} ${envFlag}-- ${shellQuote(binPath)}`;
}

/** TOML block for Codex's `~/.codex/config.toml` `[mcp_servers.<name>]` table. */
function codexToml(binPath: string, dataRoot: string | undefined): string {
  const lines = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(binPath)}`,
    `args = []`,
  ];
  if (dataRoot && dataRoot.trim() !== "") {
    lines.push(`env = { ${DATA_DIR_ENV} = ${tomlString(dataRoot)} }`);
  }
  return lines.join("\n");
}

/** Single-quote a value for a POSIX shell, escaping embedded single quotes. */
function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Render a TOML basic string (double-quoted, escaping backslash + quote). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render the ready-to-paste config snippets, one per agent. Pure: formats
 * strings from the (defaulted) input. `binPath` defaults to the bare
 * {@link LOQUI_MCP_BIN} name (for a globally-installed standalone); the app
 * passes the resolved absolute bundled-bin path. `dataRoot`, when present, is
 * threaded into each snippet's env so the agent serves the app's data root.
 */
export const generateConfigSnippets: GenerateConfigSnippets = (
  input?: McpConfigInput,
): McpConfigSnippet[] => {
  const { binPath, dataRoot } = mcpConfigInputSchema.parse(input ?? {});
  const bin = binPath && binPath.trim() !== "" ? binPath : LOQUI_MCP_BIN;
  return [
    {
      target: "claude-code",
      label: "Claude Code",
      language: "bash",
      content: claudeCodeAddCommand(bin, dataRoot),
    },
    {
      target: "claude-desktop",
      label: "Claude Desktop",
      language: "json",
      content: mcpServersJson(bin, dataRoot),
    },
    {
      target: "codex",
      label: "Codex",
      language: "toml",
      content: codexToml(bin, dataRoot),
    },
  ];
};
