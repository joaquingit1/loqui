/**
 * Hermetic tests for the main-process MCP IPC bridge + config snippets (PRD-7).
 *
 * `electron` is mocked with a fake `ipcMain` that records `handle` registrations
 * so we invoke the bound handlers directly (no Electron runtime). The manager is
 * a fake. Covers: status/enable/disable delegate to the manager; getConfigSnippets
 * renders one snippet per agent pointing at the resolved bin + data root; the
 * status push reaches the live window; the disposer removes every handler; and
 * the READ-ONLY invariant (no write/edit/delete channel; snippets reference no
 * mutating tool — structural).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_CONFIG_TARGETS, type McpStatus } from "@loqui/shared";
import { generateConfigSnippets } from "./snippets.js";

// --- Fake electron ipcMain (records registrations; lets us invoke handlers) ---
interface RecordedHandlers {
  handle: Map<string, (e: unknown, ...args: unknown[]) => unknown>;
  removedHandlers: string[];
}
const handlers: RecordedHandlers = { handle: new Map(), removedHandlers: [] };

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.handle.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.removedHandlers.push(channel);
      handlers.handle.delete(channel);
    },
  },
}));

// Imported AFTER the mock so the module binds the fake ipcMain.
const { registerMcpIpc, makeMcpStatusPush } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");

const RUNNING: McpStatus = {
  running: true,
  transport: "http",
  url: "http://127.0.0.1:7333",
  dataRoot: "/data/root",
  pid: 99,
};
const STOPPED: McpStatus = {
  running: false,
  transport: "http",
  url: null,
  dataRoot: "/data/root",
  pid: null,
};

function makeManager() {
  return {
    status: vi.fn((): McpStatus => STOPPED),
    enable: vi.fn((): McpStatus => RUNNING),
    disable: vi.fn((): McpStatus => STOPPED),
    getBinPath: vi.fn((): string => "/abs/loqui-mcp"),
    getDataRoot: vi.fn((): string => "/data/root"),
  };
}

beforeEach(() => {
  handlers.handle.clear();
  handlers.removedHandlers = [];
});
afterEach(() => vi.restoreAllMocks());

describe("registerMcpIpc — invoke handlers", () => {
  it("status delegates to the manager", () => {
    const manager = makeManager();
    registerMcpIpc({ manager });
    const result = handlers.handle.get(IPC.mcpStatus)!(null) as McpStatus;
    expect(manager.status).toHaveBeenCalled();
    expect(result).toEqual(STOPPED);
  });

  it("enable delegates and returns the running status", () => {
    const manager = makeManager();
    registerMcpIpc({ manager });
    const result = handlers.handle.get(IPC.mcpEnable)!(null) as McpStatus;
    expect(manager.enable).toHaveBeenCalled();
    expect(result.running).toBe(true);
    expect(result.url).toBe("http://127.0.0.1:7333");
  });

  it("disable delegates and returns the stopped status", () => {
    const manager = makeManager();
    registerMcpIpc({ manager });
    const result = handlers.handle.get(IPC.mcpDisable)!(null) as McpStatus;
    expect(manager.disable).toHaveBeenCalled();
    expect(result.running).toBe(false);
  });

  it("getConfigSnippets renders one snippet per agent from the resolved bin + root", () => {
    const manager = makeManager();
    registerMcpIpc({ manager });
    const snippets = handlers.handle.get(IPC.mcpGetConfigSnippets)!(null) as ReturnType<
      typeof generateConfigSnippets
    >;
    expect(manager.getBinPath).toHaveBeenCalled();
    expect(manager.getDataRoot).toHaveBeenCalled();
    expect(snippets.map((s) => s.target)).toEqual([...MCP_CONFIG_TARGETS]);
    // Every snippet points at the resolved bin + threads the data root.
    for (const s of snippets) {
      expect(s.content).toContain("/abs/loqui-mcp");
      expect(s.content).toContain("/data/root");
    }
  });

  it("the disposer removes every handler it registered", () => {
    const dispose = registerMcpIpc({ manager: makeManager() });
    dispose();
    expect(handlers.removedHandlers).toEqual(
      expect.arrayContaining([
        IPC.mcpStatus,
        IPC.mcpEnable,
        IPC.mcpDisable,
        IPC.mcpGetConfigSnippets,
      ]),
    );
  });
});

describe("makeMcpStatusPush — status push to the renderer", () => {
  function makeWindow() {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    return {
      sent,
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
  }

  it("pushes the status on IPC.mcpStatusChanged", () => {
    const win = makeWindow();
    const push = makeMcpStatusPush(() => win as never);
    push(RUNNING);
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0]!.channel).toBe(IPC.mcpStatusChanged);
    expect(win.sent[0]!.payload).toEqual(RUNNING);
  });

  it("does not throw with no live window", () => {
    const push = makeMcpStatusPush(() => null);
    expect(() => push(RUNNING)).not.toThrow();
  });

  it("does not push to a destroyed window", () => {
    const sent: unknown[] = [];
    const win = { isDestroyed: () => true, webContents: { send: (_c: string, p: unknown) => sent.push(p) } };
    const push = makeMcpStatusPush(() => win as never);
    push(RUNNING);
    expect(sent).toHaveLength(0);
  });
});

describe("generateConfigSnippets — content", () => {
  it("renders Claude Code (bash), Claude Desktop (json), Codex (toml)", () => {
    const snippets = generateConfigSnippets({ binPath: "/abs/loqui-mcp", dataRoot: "/data/root" });
    const byTarget = Object.fromEntries(snippets.map((s) => [s.target, s]));

    expect(byTarget["claude-code"]!.language).toBe("bash");
    expect(byTarget["claude-code"]!.content).toContain("claude mcp add loqui");
    expect(byTarget["claude-code"]!.content).toContain("LOQUI_DATA_DIR=/data/root");

    expect(byTarget["claude-desktop"]!.language).toBe("json");
    const parsed = JSON.parse(byTarget["claude-desktop"]!.content) as {
      mcpServers: Record<string, { command: string; env?: Record<string, string> }>;
    };
    expect(parsed.mcpServers["loqui"]!.command).toBe("/abs/loqui-mcp");
    expect(parsed.mcpServers["loqui"]!.env?.LOQUI_DATA_DIR).toBe("/data/root");

    expect(byTarget["codex"]!.language).toBe("toml");
    expect(byTarget["codex"]!.content).toContain("[mcp_servers.loqui]");
    expect(byTarget["codex"]!.content).toContain('command = "/abs/loqui-mcp"');
    expect(byTarget["codex"]!.content).toContain('LOQUI_DATA_DIR = "/data/root"');
  });

  it("falls back to the bare bin name + omits env when no data root is given", () => {
    const snippets = generateConfigSnippets();
    const code = snippets.find((s) => s.target === "claude-code")!;
    expect(code.content).toContain("loqui-mcp");
    expect(code.content).not.toContain("LOQUI_DATA_DIR");
    const desktop = JSON.parse(snippets.find((s) => s.target === "claude-desktop")!.content) as {
      mcpServers: Record<string, { command: string; env?: unknown }>;
    };
    expect(desktop.mcpServers["loqui"]!.command).toBe("loqui-mcp");
    expect(desktop.mcpServers["loqui"]!.env).toBeUndefined();
  });

  it("shell-quotes a data root with spaces for Claude Code", () => {
    const snippets = generateConfigSnippets({
      binPath: "/Apps/Loqui.app/loqui-mcp",
      dataRoot: "/Users/me/My Loqui",
    });
    const code = snippets.find((s) => s.target === "claude-code")!;
    expect(code.content).toContain("'/Users/me/My Loqui'");
  });

  it("READ-ONLY: no snippet references a write/edit/delete tool or a non-loopback host", () => {
    const snippets = generateConfigSnippets({ binPath: "/abs/loqui-mcp", dataRoot: "/data/root" });
    for (const s of snippets) {
      expect(s.content).not.toMatch(/--write|--rw|write|delete|edit/i);
      expect(s.content).not.toMatch(/0\.0\.0\.0|--host\b/);
    }
  });
});
