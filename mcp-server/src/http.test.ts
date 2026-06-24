/**
 * PRD-7 — loopback HTTP/SSE transport tests.
 *
 * Hermetic + loopback-only (no off-box network). Builds a minimal real McpServer
 * with one tool, attaches it via {@link startHttpTransport}, connects a real MCP
 * Client over Streamable-HTTP, and asserts:
 *   - the bound url is on the loopback host {@link MCP_HTTP_HOST},
 *   - tools/list + tools/call work over HTTP (same tool surface as stdio),
 *   - a non-loopback host is REFUSED (security invariant),
 *   - close() tears the listener down.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_HTTP_HOST, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "@loqui/shared";
import { MCP_HTTP_PATH, startHttpTransport, type HttpTransportHandle } from "./http.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  server.registerTool(
    "echo",
    {
      description: "Echo back the provided message.",
      inputSchema: { message: z.string() },
    },
    ({ message }) => ({ content: [{ type: "text", text: `echo:${message}` }] }),
  );
  return server;
}

const handles: HttpTransportHandle[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const h of handles.splice(0)) await h.close().catch(() => {});
});

async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("startHttpTransport", () => {
  it("binds the loopback host and serves /mcp", async () => {
    const handle = await startHttpTransport(buildServer(), { port: 0 });
    handles.push(handle);
    expect(handle.url.startsWith(`http://${MCP_HTTP_HOST}:`)).toBe(true);
    expect(handle.url.endsWith(MCP_HTTP_PATH)).toBe(true);
    expect(handle.port).toBeGreaterThan(0);
  });

  it("serves tools/list and tools/call over HTTP", async () => {
    const handle = await startHttpTransport(buildServer(), { port: 0 });
    handles.push(handle);
    const client = await connectClient(handle.url);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");

    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
    })) as { content: Array<{ type: string; text?: string }> };
    const text = result.content.find((c) => c.type === "text")?.text;
    expect(text).toBe("echo:hi");
  });

  it("refuses a non-loopback host", async () => {
    await expect(startHttpTransport(buildServer(), { host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /non-loopback/i,
    );
  });

  it("returns 404 for a non-/mcp path", async () => {
    const handle = await startHttpTransport(buildServer(), { port: 0 });
    handles.push(handle);
    const base = handle.url.slice(0, handle.url.length - MCP_HTTP_PATH.length);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("close() is idempotent and frees the port", async () => {
    const handle = await startHttpTransport(buildServer(), { port: 0 });
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    // a fresh bind on the same explicit port should now succeed
    const reopened = await startHttpTransport(buildServer(), { port: handle.port });
    handles.push(reopened);
    expect(reopened.port).toBe(handle.port);
  });
});
