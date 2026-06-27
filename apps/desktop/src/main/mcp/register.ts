/**
 * MCP server IPC registration (PRD-7, main side).
 *
 * The single place main binds the `window.loqui.mcp` surface (defined in
 * src/preload/index.ts) to the app-managed {@link McpServerManager} + the pure
 * config-snippet generator.
 *
 * Channels (from src/shared/ipc.ts):
 *   - mcpStatus (invoke)           : current managed-server status.
 *   - mcpGetConfigSnippets (invoke): ready-to-paste agent config snippets.
 *   - mcpStatusChanged (push)      : managed-server status changed.
 *
 * The server runs whenever Loqui is open (no user toggle) — main auto-starts it
 * at bootstrap — so there is no enable/disable channel here.
 *
 * STRICTLY READ-ONLY: every channel here either reports status or returns config
 * text — none reads or writes a meeting. There is no write/edit/delete channel
 * and no payload that mutates the store.
 */
import { ipcMain, type BrowserWindow } from "electron";
import type { McpConfigSnippet, McpStatus } from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { McpServerManager } from "./lifecycle.js";
import { generateConfigSnippets } from "./snippets.js";

export interface McpIpcDeps {
  /** The app-managed MCP server lifecycle (status + resolved bin/dataRoot). */
  manager: Pick<McpServerManager, "status" | "getBinPath" | "getDataRoot">;
}

/**
 * Register the MCP invoke handlers. Returns a disposer.
 *
 * The config snippets are rendered from the manager's resolved bin path +
 * data root so the printed agent config points at the SAME bin + store the app
 * uses. All handlers are read-only over the store.
 */
export function registerMcpIpc(deps: McpIpcDeps): () => void {
  const { manager } = deps;

  ipcMain.handle(IPC.mcpStatus, (): McpStatus => manager.status());
  ipcMain.handle(IPC.mcpGetConfigSnippets, (): McpConfigSnippet[] =>
    generateConfigSnippets({ binPath: manager.getBinPath(), dataRoot: manager.getDataRoot() }),
  );

  return () => {
    ipcMain.removeHandler(IPC.mcpStatus);
    ipcMain.removeHandler(IPC.mcpGetConfigSnippets);
  };
}

/**
 * Push managed-server status changes to the renderer on {@link IPC.mcpStatusChanged}
 * (PRD-7). Returns the listener to hand to {@link McpServerManager} via its
 * `onStatusChange` dep (or call directly). `getWindow` resolves the live window
 * at emit time so the push survives window recreation. Mirrors the PRD-2/4/5
 * status-push pattern — no new transport.
 */
export function makeMcpStatusPush(
  getWindow: () => BrowserWindow | null,
): (status: McpStatus) => void {
  return (status: McpStatus) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.mcpStatusChanged, status);
    }
  };
}
