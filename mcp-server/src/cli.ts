/**
 * PRD-7 — the standalone `loqui-mcp` CLI runtime.
 *
 * Wires the parsed bin options (transport / data root / loopback port) onto the
 * server-core factory and runs the server until a stop signal. Owns the runtime
 * concerns the bin shell delegates here:
 *   - build the server via the core `createMcpServer` (stdio by default; `--http`
 *     selects the loopback HTTP/SSE transport),
 *   - install SIGINT/SIGTERM handlers that stop it cleanly (closing the readonly
 *     db + releasing the transport),
 *   - keep stdout RESERVED for the MCP protocol stream — every human/log line
 *     goes to stderr,
 *   - resolve `run()` once the server is up (so tests can await readiness) and
 *     expose a `stop()` for programmatic teardown.
 *
 * STRICTLY READ-ONLY: this only starts the read-only server the core builds; it
 * registers no tools and opens no db itself. There is no write code path here.
 */
import { mcpServerOptionsSchema, type CreateMcpServer, type McpServerHandle, type McpServerOptions } from "@loqui/shared";
import { parseBinArgs } from "./bin/loqui-mcp.js";

/** Where human/log output goes. NEVER stdout — that is the stdio MCP stream. */
function logStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** A running CLI session: the server handle + a stop() that also removes signal handlers. */
export interface CliSession {
  /** The underlying server handle (transport + url + stop). */
  handle: McpServerHandle;
  /** Stop the server and detach signal handlers. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Lazily load the server-core factory. Kept a dynamic import so this CLI module
 * (owned by the cli/http/config unit) does not hard-compile against the
 * server-core file (owned by another unit) — both type against the shared
 * {@link CreateMcpServer} signature. Overridable in tests via the `factory` arg.
 */
async function loadFactory(): Promise<CreateMcpServer> {
  const mod = (await import("./server.js")) as { createMcpServer: CreateMcpServer };
  return mod.createMcpServer;
}

/**
 * Start the server from already-parsed options and wire signal handlers. Returns
 * a {@link CliSession} once the server is up. `factory` is injectable for tests
 * (defaults to the server-core `createMcpServer`).
 */
export async function startCli(
  options: McpServerOptions,
  factory?: CreateMcpServer,
): Promise<CliSession> {
  const createMcpServer = factory ?? (await loadFactory());
  const opts = mcpServerOptionsSchema.parse(options);
  const handle = await createMcpServer(opts);

  if (handle.transport === "http" && handle.url) {
    logStderr(`loqui-mcp: serving MCP over HTTP at ${handle.url} (loopback only)`);
  } else {
    logStderr("loqui-mcp: serving MCP over stdio");
  }

  let stopped = false;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const onSignal = (sig: NodeJS.Signals): void => {
    logStderr(`loqui-mcp: received ${sig}, shutting down`);
    void stop();
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const sig of signals) process.removeListener(sig, onSignal);
    await handle.stop();
  };

  for (const sig of signals) process.on(sig, onSignal);

  return { handle, stop };
}

/**
 * The CLI entrypoint the bin shell calls: parse argv/env -> options, start the
 * server, and (for stdio) keep the process alive on the transport until a stop
 * signal. Resolves the {@link CliSession} once the server is up. `factory` is
 * injectable for tests.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  factory?: CreateMcpServer,
): Promise<CliSession> {
  const options = parseBinArgs(argv, env);
  return startCli(options, factory);
}
