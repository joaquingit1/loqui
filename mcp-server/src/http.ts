/**
 * PRD-7 — the OPTIONAL local HTTP/SSE transport for the read-only MCP server.
 *
 * Binds a Node HTTP server to LOOPBACK ONLY (127.0.0.1 — never a public host)
 * and serves the MCP Streamable-HTTP/SSE protocol on `/mcp`, backed by the SAME
 * already-built {@link McpServer} the stdio path uses (the core
 * `createMcpServer` factory builds + registers the 5 read-only tools; this
 * module only attaches a transport). So the tool surface — and the read-only
 * invariant — is identical across transports.
 *
 * The server factory (`server.ts`, owned by the server-core unit) calls
 * {@link startHttpTransport} when `options.transport === "http"`. It is kept a
 * standalone, independently-testable helper: hand it an McpServer + a loopback
 * host/port and it returns the bound url + a close() that tears down the HTTP
 * server and the transport.
 *
 * SECURITY: the host is pinned to {@link MCP_HTTP_HOST}; a non-loopback host is
 * REJECTED (throws) so HTTP can never be exposed off-box. DNS-rebinding
 * protection is enabled (Host header must be the loopback host) to stop a remote
 * web page from driving the local server via the browser.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_HTTP_DEFAULT_PORT, MCP_HTTP_HOST } from "@loqui/shared";

/** The single HTTP path the MCP Streamable-HTTP transport is served on. */
export const MCP_HTTP_PATH = "/mcp" as const;

/** Options for {@link startHttpTransport}. Host pinned to loopback; port 0 = OS-assigned. */
export interface StartHttpTransportOptions {
  /** Loopback host to bind. MUST be {@link MCP_HTTP_HOST}; anything else throws. */
  host?: string;
  /** Port to bind (default {@link MCP_HTTP_DEFAULT_PORT}; 0 lets the OS pick a free port). */
  port?: number;
}

/** A running loopback HTTP transport. */
export interface HttpTransportHandle {
  /** The bound loopback url, e.g. `http://127.0.0.1:7333/mcp`. */
  url: string;
  /** The actually-bound port (resolved when port 0 was requested). */
  port: number;
  /** Stop the HTTP server + close the transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * Attach a loopback Streamable-HTTP/SSE transport to an already-built
 * {@link McpServer} and start listening. Stateless (no session id) +
 * JSON-response mode so a single transport serves all requests on `/mcp`.
 *
 * @throws if `host` is not the pinned loopback host.
 */
export async function startHttpTransport(
  server: McpServer,
  opts: StartHttpTransportOptions = {},
): Promise<HttpTransportHandle> {
  const host = opts.host ?? MCP_HTTP_HOST;
  if (host !== MCP_HTTP_HOST) {
    throw new Error(
      `loqui-mcp http transport refuses non-loopback host ${JSON.stringify(host)}; only ${MCP_HTTP_HOST} is allowed`,
    );
  }
  const port = opts.port ?? MCP_HTTP_DEFAULT_PORT;

  // Create + bind the HTTP server FIRST (no request handler yet) so we know the
  // actually-bound port (port 0 = OS-assigned) before constructing the
  // transport — that lets DNS-rebinding protection pin the Host header to the
  // real loopback host:port. The request handler is attached only after the
  // transport exists + the server is connected, so no request can race it.
  const httpServer: Server = createServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onError);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  const boundPort = address && typeof address === "object" ? address.port : port;

  // Stateful transport: a per-connection session id (the MCP peer echoes it back
  // on every request) so client-issued notifications (e.g.
  // notifications/initialized) route to the right session. JSON-response mode
  // keeps simple request/response calls non-streaming. DNS-rebinding protection
  // pins the Host header to the loopback host (incl. the actually-bound port) so
  // a browser on a malicious page can't reach the server via a rebound DNS name.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [MCP_HTTP_HOST, `${MCP_HTTP_HOST}:${boundPort}`],
  });
  await server.connect(transport);

  httpServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?", 1)[0];
    if (path !== MCP_HTTP_PATH) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", expected: MCP_HTTP_PATH }));
      return;
    }
    // Delegate the MCP protocol (POST messages, GET SSE stream, DELETE session)
    // to the transport. It reads/parses the body itself.
    transport.handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      } else {
        res.end();
      }
    });
  });

  const url = `http://${host}:${boundPort}${MCP_HTTP_PATH}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await transport.close().catch(() => {});
  };

  return { url, port: boundPort, close };
}
