/**
 * PRD-7 test fixture — a spawnable entry that exercises the REAL CLI runtime
 * ({@link runCli}) over a child process, using a hermetic stdio server factory
 * injected in place of the server-core `createMcpServer` (which a sibling unit
 * owns). This proves the cli/bin wiring end-to-end — arg parsing, factory call,
 * stdio transport connect, stdout reserved for the protocol, process kept alive
 * until stdin closes / a signal — without coupling this unit's tests to the
 * server-core file.
 *
 * The injected factory registers a `report_root` tool that returns the resolved
 * data root so the test can assert LOQUI_DATA_DIR was honored through the CLI.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  mcpServerOptionsSchema,
  type CreateMcpServer,
} from "@loqui/shared";
import { runCli } from "../cli.js";

const fakeFactory: CreateMcpServer = async (options) => {
  const opts = mcpServerOptionsSchema.parse(options ?? {});
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  server.registerTool(
    "report_root",
    { description: "Report the resolved data root the server was started with." },
    () => ({ content: [{ type: "text", text: `root:${opts.dataRoot ?? ""}` }] }),
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    transport: "stdio" as const,
    url: null,
    stop: async () => {
      await server.close();
    },
  };
};

void runCli(process.argv.slice(2), process.env, fakeFactory).catch((err: unknown) => {
  process.stderr.write(`stdio-cli-entry: ${String(err)}\n`);
  process.exit(1);
});
