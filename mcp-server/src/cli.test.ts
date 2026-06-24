/**
 * PRD-7 — standalone CLI runtime tests.
 *
 * In-process: {@link startCli}/{@link runCli} with an injected fake factory —
 * asserts the factory receives the parsed options, signal handlers are
 * installed + removed on stop, and stop() delegates to handle.stop().
 *
 * Spawned (hermetic stdio smoke): runs the REAL cli via a child process against
 * a seeded temp LOQUI_DATA_DIR, then drives it with a real MCP Client over a
 * StdioClientTransport — MCP initialize + tools/list succeed and the data root
 * threads through. stdout stays a clean protocol stream (a parse error would
 * fail the handshake).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_HTTP_DEFAULT_PORT, type CreateMcpServer, type McpServerHandle } from "@loqui/shared";
import { runCli, startCli } from "./cli.js";

const here = dirname(fileURLToPath(import.meta.url));

function fakeHandle(transport: "stdio" | "http" = "stdio"): McpServerHandle & { stopped: number } {
  return {
    transport,
    url: transport === "http" ? "http://127.0.0.1:7333/mcp" : null,
    stopped: 0,
    async stop() {
      this.stopped++;
    },
  };
}

const sessions: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop().catch(() => {});
  vi.restoreAllMocks();
});

describe("startCli / runCli (in-process, injected factory)", () => {
  it("passes the parsed options to the factory and installs signal handlers", async () => {
    const handle = fakeHandle("stdio");
    const factory = vi.fn<CreateMcpServer>(async () => handle);
    const beforeSigint = process.listenerCount("SIGINT");

    const session = await runCli(["--http", "--port", "0"], { LOQUI_DATA_DIR: "/seed/root" }, factory);
    sessions.push(session);

    expect(factory).toHaveBeenCalledTimes(1);
    const passed = factory.mock.calls[0]?.[0];
    expect(passed?.transport).toBe("http");
    expect(passed?.dataRoot).toBe("/seed/root");
    expect(passed?.httpPort).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
  });

  it("stop() calls handle.stop() once and detaches signal handlers", async () => {
    const handle = fakeHandle("stdio");
    const factory: CreateMcpServer = async () => handle;
    const beforeSigterm = process.listenerCount("SIGTERM");

    const session = await startCli({ transport: "stdio" }, factory);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm + 1);

    await session.stop();
    await session.stop(); // idempotent
    expect(handle.stopped).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("defaults to stdio with the default loopback port when no flags", async () => {
    const handle = fakeHandle("stdio");
    const factory = vi.fn<CreateMcpServer>(async () => handle);
    const session = await runCli([], {}, factory);
    sessions.push(session);
    const passed = factory.mock.calls[0]?.[0];
    expect(passed?.transport).toBe("stdio");
    expect(passed?.httpPort).toBe(MCP_HTTP_DEFAULT_PORT);
    expect(passed?.dataRoot).toBeUndefined();
  });
});

describe("loqui-mcp CLI over stdio (spawned child process)", () => {
  it("starts, completes MCP initialize + tools/list, honoring LOQUI_DATA_DIR", async () => {
    const require = createRequire(import.meta.url);
    // Resolve the tsx CLI so we can run the .ts fixture in a child process.
    const tsxCli = require.resolve("tsx/cli");
    const entry = resolve(here, "__fixtures__/stdio-cli-entry.ts");
    const dataRoot = resolve(here, "__fixtures__"); // any existing dir; fixture only echoes it

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, entry],
      env: { ...process.env, LOQUI_DATA_DIR: dataRoot },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0.0.0" });

    try {
      await client.connect(transport); // performs MCP initialize
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("report_root");

      const res = (await client.callTool({ name: "report_root", arguments: {} })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.find((c) => c.type === "text")?.text;
      expect(text).toBe(`root:${dataRoot}`);
    } finally {
      await client.close().catch(() => {});
    }
  }, 30000);
});
