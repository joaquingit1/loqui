/**
 * @file Main-process local MCP server integration (PRD-7) public surface.
 *
 * Re-exports the app-managed MCP server lifecycle ({@link McpServerManager} —
 * spawn/stop the bundled read-only `loqui-mcp` bin + track status), the IPC
 * bridge (status/enable/disable/getConfigSnippets + the status push), and the
 * pure config-snippet generator, so the main wiring + tests import from one place.
 *
 * INVARIANT (re-asserted at the module boundary): NOTHING exported here reads or
 * writes a meeting. The manager only starts/stops the strictly read-only server
 * bin and reports status; the IPC handlers report status / start-stop / return
 * config text. Any HTTP transport binds 127.0.0.1 only.
 */
export {
  McpServerManager,
  defaultMcpSpawn,
  resolveMcpBinPath,
  resolveDataRoot,
  type McpServerManagerDeps,
  type McpSpawnFn,
} from "./lifecycle.js";
export { registerMcpIpc, makeMcpStatusPush, type McpIpcDeps } from "./register.js";
export { generateConfigSnippets } from "./snippets.js";
