/**
 * PRD-7 — ready-to-paste agent config snippets for the standalone `loqui-mcp`
 * stdio server.
 *
 * Pure string formatters (no I/O): given the resolved bin path + the data root
 * the server should serve, render the literal config a user pastes into each
 * supported agent. ONE generator so Settings (via IPC) and any docs print
 * identical, correct snippets. Implements {@link GenerateConfigSnippets}.
 *
 * All snippets point at the LOCAL stdio server (`command` = the bin), pass the
 * data root via `LOQUI_DATA_DIR` so the agent's server reads the SAME meetings
 * the app wrote, and never reference any network endpoint — this is a local,
 * read-only memory, not a cloud account.
 */
import {
  LOQUI_MCP_BIN,
  MCP_SERVER_NAME,
  mcpConfigInputSchema,
  type GenerateConfigSnippets,
  type McpConfigInput,
  type McpConfigSnippet,
} from "@loqui/shared";

/**
 * TOML basic-string encode (double-quoted). Escapes backslash, double-quote and
 * the control chars TOML requires escaped, so a Windows path like
 * `C:\Users\me\loqui-mcp.exe` round-trips into a valid `command = "..."`.
 */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Shell-quote a token for the `claude mcp add ... -- <command>` line. Bare when
 * it has no shell-significant chars; otherwise single-quoted (with embedded
 * single-quotes escaped the POSIX way). Keeps the common `loqui-mcp` case clean
 * while staying safe for absolute paths containing spaces.
 */
function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the three agent config snippets (claude-code, claude-desktop, codex)
 * for the local stdio `loqui-mcp` server. `input.binPath` defaults to the bare
 * bin name (a globally-installed standalone); `input.dataRoot`, when provided,
 * is threaded into each snippet via `LOQUI_DATA_DIR` so the agent serves the
 * SAME data root as the app.
 */
export const generateConfigSnippets: GenerateConfigSnippets = (
  input?: McpConfigInput,
): McpConfigSnippet[] => {
  const { binPath, dataRoot } = mcpConfigInputSchema.parse(input ?? {});
  const command = binPath || LOQUI_MCP_BIN;
  const hasDataRoot = typeof dataRoot === "string" && dataRoot.trim() !== "";

  // --- Claude Code: `claude mcp add` command (options BEFORE the name, then
  // `--` then the server command). Local stdio, optional --env for the root.
  const claudeCodeParts = ["claude", "mcp", "add", "--transport", "stdio"];
  if (hasDataRoot) {
    claudeCodeParts.push("--env", `LOQUI_DATA_DIR=${shellArg(dataRoot)}`);
  }
  claudeCodeParts.push(MCP_SERVER_NAME, "--", shellArg(command));
  const claudeCode: McpConfigSnippet = {
    target: "claude-code",
    label: "Claude Code",
    language: "bash",
    content: claudeCodeParts.join(" "),
  };

  // --- Claude Desktop: a `claude_desktop_config.json` fragment. stdio server
  // under mcpServers.loqui with command/args/env.
  const desktopConfig = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command,
        args: [] as string[],
        ...(hasDataRoot ? { env: { LOQUI_DATA_DIR: dataRoot } } : {}),
      },
    },
  };
  const claudeDesktop: McpConfigSnippet = {
    target: "claude-desktop",
    label: "Claude Desktop",
    language: "json",
    content: JSON.stringify(desktopConfig, null, 2),
  };

  // --- Codex: a `~/.codex/config.toml` fragment. [mcp_servers.<name>] with a
  // command + (optional) nested env table.
  const codexLines = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = []`,
  ];
  if (hasDataRoot) {
    codexLines.push("", `[mcp_servers.${MCP_SERVER_NAME}.env]`, `LOQUI_DATA_DIR = ${tomlString(dataRoot)}`);
  }
  const codex: McpConfigSnippet = {
    target: "codex",
    label: "Codex",
    language: "toml",
    content: codexLines.join("\n"),
  };

  return [claudeCode, claudeDesktop, codex];
};
