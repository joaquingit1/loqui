#!/usr/bin/env node
/**
 * `loqui-mcp` — the STANDALONE entrypoint for Loqui's read-only MCP server
 * (PRD-7). Runs WITHOUT the Electron app (reads `<dataRoot>/index.db` + the
 * meeting files directly), so an agent config can point at it and query past
 * meetings whether or not Loqui is open.
 *
 * BIN CONTRACT (Foundation pins it; Build phase fills `createMcpServer`):
 *   - Data root: resolved from `LOQUI_DATA_DIR` (else `~/Loqui`) — the SAME root
 *     the app uses. Honored by the ReadStore the server is built on.
 *   - Transport: `stdio` by DEFAULT (what agent configs use). `--http` selects
 *     the OPTIONAL loopback Streamable-HTTP/SSE transport (bound to 127.0.0.1
 *     only); `--port <n>` sets its port (default {@link MCP_HTTP_DEFAULT_PORT}).
 *   - stdout on stdio is RESERVED for the MCP protocol stream — all human/log
 *     output goes to stderr.
 *   - Exit: SIGINT/SIGTERM stop the server cleanly (closing the readonly db).
 *
 * STRICTLY READ-ONLY: the server registers exactly the 5 read tools and opens
 * SQLite readonly — there is no write code path here.
 */
import {
  MCP_HTTP_DEFAULT_PORT,
  mcpServerOptionsSchema,
  type McpServerOptions,
} from "@loqui/shared";

/**
 * Parse the CLI args + env into validated {@link McpServerOptions}. Pure: no I/O,
 * no process exit — testable in isolation. `LOQUI_DATA_DIR` (when set non-empty)
 * becomes `dataRoot`; `--http` selects the http transport; `--port <n>` (or
 * `--port=n`) sets the loopback port. Unknown flags are ignored (forward-compat).
 */
export function parseBinArgs(argv: string[], env: NodeJS.ProcessEnv): McpServerOptions {
  let transport: "stdio" | "http" = "stdio";
  let httpPort: number = MCP_HTTP_DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--http") {
      transport = "http";
    } else if (arg === "--port") {
      const next = argv[i + 1];
      if (next !== undefined) {
        const n = Number.parseInt(next, 10);
        if (Number.isFinite(n)) httpPort = n;
        i++;
      }
    } else if (arg?.startsWith("--port=")) {
      const n = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(n)) httpPort = n;
    }
  }
  const dataDir = env.LOQUI_DATA_DIR;
  const options: McpServerOptions = {
    transport,
    httpPort,
    ...(dataDir && dataDir.trim() !== "" ? { dataRoot: dataDir } : {}),
  };
  // Validate/normalize through the shared schema (also pins httpHost to loopback).
  return mcpServerOptionsSchema.parse(options);
}

/**
 * Bin entrypoint. Delegates the runtime wiring to {@link runCli} (cli.ts): parse
 * argv/env -> options, build the server over the parsed transport via the
 * server-core `createMcpServer`, install SIGINT/SIGTERM handlers that stop it
 * cleanly, and (for stdio) keep the process alive on the transport — the
 * connected MCP stdio transport holds the event loop open until the peer closes
 * stdin or a stop signal arrives. stdout stays reserved for the protocol stream.
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const { runCli } = await import("../cli.js");
  await runCli(argv, env);
}

// Only run when invoked as the bin, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`loqui-mcp: ${String(err)}\n`);
    process.exit(1);
  });
}
