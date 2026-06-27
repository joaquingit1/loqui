/**
 * @file Main-process local MCP server integration (PRD-7) public surface.
 *
 * Re-exports the app-managed MCP server lifecycle ({@link McpServerManager} —
 * spawn/stop the bundled read-only `loqui-mcp` bin). The server is ALWAYS started
 * at app launch with NO UI surface (no enable/disable, no settings panel) — it
 * just runs while Loqui is open so an external agent can read meetings over MCP.
 *
 * INVARIANT (re-asserted at the module boundary): NOTHING exported here reads or
 * writes a meeting. The manager only starts/stops the strictly read-only server
 * bin. Any HTTP transport binds 127.0.0.1 only.
 */
export {
  McpServerManager,
  defaultMcpSpawn,
  resolveMcpBinPath,
  resolveDataRoot,
  type McpServerManagerDeps,
  type McpSpawnFn,
} from "./lifecycle.js";
