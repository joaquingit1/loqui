/**
 * PRD-7 — config-snippet generator tests.
 *
 * Hermetic + pure: no I/O, no network. Asserts the three agent snippets are
 * present, correctly targeted, and parse/shape-check as valid configs (JSON
 * parses; the claude-code bash command is well-formed `claude mcp add`; the
 * codex TOML carries the [mcp_servers.loqui] table). Also asserts the data root
 * is threaded via LOQUI_DATA_DIR and that NO snippet implies a write/cloud path.
 */
import { describe, expect, it } from "vitest";
import {
  LOQUI_MCP_BIN,
  MCP_CONFIG_TARGETS,
  MCP_SERVER_NAME,
  mcpConfigSnippetSchema,
} from "@loqui/shared";
import { generateConfigSnippets } from "./config-snippets.js";

const byTarget = (snips: ReturnType<typeof generateConfigSnippets>, t: string) => {
  const s = snips.find((x) => x.target === t);
  if (!s) throw new Error(`missing snippet for target ${t}`);
  return s;
};

describe("generateConfigSnippets", () => {
  it("emits exactly one snippet per config target, all schema-valid", () => {
    const snips = generateConfigSnippets();
    expect(snips).toHaveLength(MCP_CONFIG_TARGETS.length);
    const targets = snips.map((s) => s.target).sort();
    expect(targets).toEqual([...MCP_CONFIG_TARGETS].sort());
    for (const s of snips) {
      expect(() => mcpConfigSnippetSchema.parse(s)).not.toThrow();
    }
  });

  it("defaults the command to the bare loqui-mcp bin when no binPath given", () => {
    const snips = generateConfigSnippets();
    for (const s of snips) {
      expect(s.content).toContain(LOQUI_MCP_BIN);
    }
  });

  it("claude-code snippet is a well-formed `claude mcp add` stdio command", () => {
    const s = byTarget(generateConfigSnippets({ binPath: "/usr/local/bin/loqui-mcp" }), "claude-code");
    expect(s.language).toBe("bash");
    // options BEFORE the name, then `--` then the server command.
    expect(s.content).toMatch(/^claude mcp add /);
    expect(s.content).toContain("--transport stdio");
    const dashIdx = s.content.indexOf(" -- ");
    const nameIdx = s.content.indexOf(` ${MCP_SERVER_NAME} `);
    expect(nameIdx).toBeGreaterThan(0);
    expect(dashIdx).toBeGreaterThan(nameIdx); // name precedes the `--` separator
    expect(s.content.slice(dashIdx)).toContain("/usr/local/bin/loqui-mcp");
  });

  it("claude-desktop snippet parses as JSON with mcpServers.loqui.command", () => {
    const s = byTarget(generateConfigSnippets({ binPath: "/opt/loqui-mcp" }), "claude-desktop");
    expect(s.language).toBe("json");
    const parsed = JSON.parse(s.content) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(parsed.mcpServers[MCP_SERVER_NAME]?.command).toBe("/opt/loqui-mcp");
    expect(parsed.mcpServers[MCP_SERVER_NAME]?.args).toEqual([]);
  });

  it("codex snippet declares the [mcp_servers.loqui] table with a command", () => {
    const s = byTarget(generateConfigSnippets({ binPath: "/opt/loqui-mcp" }), "codex");
    expect(s.language).toBe("toml");
    expect(s.content).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(s.content).toMatch(/command = "\/opt\/loqui-mcp"/);
    expect(s.content).toContain("args = []");
  });

  it("threads dataRoot via LOQUI_DATA_DIR into every snippet", () => {
    const dataRoot = "/Users/me/CustomLoqui";
    const snips = generateConfigSnippets({ binPath: "loqui-mcp", dataRoot });

    const cc = byTarget(snips, "claude-code");
    expect(cc.content).toContain(`--env LOQUI_DATA_DIR=${dataRoot}`);

    const cd = byTarget(snips, "claude-desktop");
    const parsed = JSON.parse(cd.content) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers[MCP_SERVER_NAME]?.env?.LOQUI_DATA_DIR).toBe(dataRoot);

    const cx = byTarget(snips, "codex");
    expect(cx.content).toContain(`[mcp_servers.${MCP_SERVER_NAME}.env]`);
    expect(cx.content).toContain(`LOQUI_DATA_DIR = "${dataRoot}"`);
  });

  it("omits LOQUI_DATA_DIR when no dataRoot provided", () => {
    const snips = generateConfigSnippets();
    for (const s of snips) {
      expect(s.content).not.toContain("LOQUI_DATA_DIR");
    }
  });

  it("escapes a Windows path safely in the codex TOML basic string", () => {
    const s = byTarget(
      generateConfigSnippets({ binPath: "C:\\Program Files\\Loqui\\loqui-mcp.exe" }),
      "codex",
    );
    // backslashes are doubled in a TOML basic string
    expect(s.content).toContain('command = "C:\\\\Program Files\\\\Loqui\\\\loqui-mcp.exe"');
  });

  it("shell-quotes a bin path with spaces in the claude-code command", () => {
    const s = byTarget(
      generateConfigSnippets({ binPath: "/Applications/Loqui App/loqui-mcp" }),
      "claude-code",
    );
    expect(s.content).toContain("'/Applications/Loqui App/loqui-mcp'");
  });

  it("never references a network/cloud endpoint (local-only)", () => {
    for (const s of generateConfigSnippets({ binPath: "loqui-mcp", dataRoot: "/x" })) {
      expect(s.content).not.toMatch(/https?:\/\//);
    }
  });
});
