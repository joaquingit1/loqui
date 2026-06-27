import { describe, expect, it, vi } from "vitest";
import {
  buildLoquiMcpEntry,
  ensureClaudeCodeRegistration,
  type LoquiMcpStdioEntry,
} from "./client-config.js";

const ENTRY = buildLoquiMcpEntry({
  execPath: "/Applications/Loqui.app/Contents/MacOS/Loqui",
  binPath: "/opt/loqui/mcp-server/dist/bin/loqui-mcp.js",
  dataRoot: "/Users/me/Loqui",
});

/** In-memory ~/.claude.json with injected read/write. */
function fsHarness(initial?: string) {
  let content = initial;
  const writeFileFn = vi.fn((_p: string, data: string) => {
    content = data;
  });
  const readFileFn = (_p: string): string => {
    if (content === undefined) {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    }
    return content;
  };
  return {
    readFileFn,
    writeFileFn,
    parsed: (): Record<string, unknown> => JSON.parse(content ?? "{}"),
    get rawContent() {
      return content;
    },
  };
}

function run(h: ReturnType<typeof fsHarness>, entry: LoquiMcpStdioEntry = ENTRY) {
  return ensureClaudeCodeRegistration({
    entry,
    claudeJsonPath: "/home/me/.claude.json",
    readFileFn: h.readFileFn,
    writeFileFn: h.writeFileFn,
  });
}

describe("buildLoquiMcpEntry", () => {
  it("runs the Loqui binary as Node (ELECTRON_RUN_AS_NODE) with the data dir", () => {
    expect(ENTRY).toEqual({
      command: "/Applications/Loqui.app/Contents/MacOS/Loqui",
      args: ["/opt/loqui/mcp-server/dist/bin/loqui-mcp.js"],
      env: { ELECTRON_RUN_AS_NODE: "1", LOQUI_DATA_DIR: "/Users/me/Loqui" },
    });
  });
});

describe("ensureClaudeCodeRegistration", () => {
  it("creates the file + entry when ~/.claude.json is missing", () => {
    const h = fsHarness(undefined);
    expect(run(h)).toBe("added");
    expect(h.parsed().mcpServers).toEqual({ loqui: ENTRY });
  });

  it("adds loqui while preserving every other top-level key and mcpServers entry", () => {
    const h = fsHarness(
      JSON.stringify({
        numStartups: 42,
        projects: { "/x": { allowedTools: [] } },
        mcpServers: { granola: { type: "http", url: "https://granola.example/mcp" } },
      }),
    );
    expect(run(h)).toBe("added");
    const out = h.parsed();
    expect(out.numStartups).toBe(42);
    expect(out.projects).toEqual({ "/x": { allowedTools: [] } });
    expect((out.mcpServers as Record<string, unknown>).granola).toEqual({
      type: "http",
      url: "https://granola.example/mcp",
    });
    expect((out.mcpServers as Record<string, unknown>).loqui).toEqual(ENTRY);
  });

  it("is idempotent — no rewrite when the entry already matches", () => {
    const h = fsHarness(JSON.stringify({ mcpServers: { loqui: ENTRY } }));
    expect(run(h)).toBe("unchanged");
    expect(h.writeFileFn).not.toHaveBeenCalled();
  });

  it("updates the entry when the resolved paths changed (app moved/updated)", () => {
    const stale = { ...ENTRY, args: ["/old/path/loqui-mcp.js"] };
    const h = fsHarness(JSON.stringify({ mcpServers: { loqui: stale } }));
    expect(run(h)).toBe("updated");
    expect((h.parsed().mcpServers as Record<string, unknown>).loqui).toEqual(ENTRY);
  });

  it("aborts (skips) on malformed JSON — never clobbers the file", () => {
    const h = fsHarness("{ this is not json ");
    expect(run(h)).toBe("skipped");
    expect(h.writeFileFn).not.toHaveBeenCalled();
    expect(h.rawContent).toBe("{ this is not json ");
  });

  it("aborts (skips) when the config root isn't a JSON object", () => {
    const h = fsHarness("[1,2,3]");
    expect(run(h)).toBe("skipped");
    expect(h.writeFileFn).not.toHaveBeenCalled();
  });
});
