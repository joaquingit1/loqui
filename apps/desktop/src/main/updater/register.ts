/**
 * PRD-8 — the updater IPC bridge + state push (main side).
 *
 * Binds the `window.loqui.updater` channels to the {@link UpdaterManager} and
 * pushes updater-state changes to the live window (mirrors registerAutoRecordIpc
 * / registerMcpIpc). Returns a disposer.
 *
 * Channels (from src/shared/ipc.ts):
 *   - updaterGetState (invoke)       : current updater runtime state.
 *   - updaterGetSettings (invoke)    : persisted updater settings.
 *   - updaterSetSettings (invoke)    : patch settings (applies live).
 *   - updaterCheckNow (invoke)       : check GitHub now (on demand).
 *   - updaterQuitAndInstall (invoke) : apply a staged update + relaunch.
 *   - updaterStateChanged (push)     : updater state changed.
 *
 * Best-effort + non-blocking: a handler never throws into the renderer beyond a
 * normal rejected invoke; a failed check is reflected on the state, not thrown.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  updateUpdaterSettingsSchema,
  type UpdaterSettings,
  type UpdaterState,
  type UpdateUpdaterSettings,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { UpdaterManager } from "./manager.js";

export interface UpdaterIpcDeps {
  manager: Pick<
    UpdaterManager,
    "getState" | "getSettings" | "setSettings" | "checkNow" | "quitAndInstall"
  >;
  getWindow: () => BrowserWindow | null;
}

/**
 * Register the updater IPC handlers. Returns a disposer that removes them.
 * (The state push is wired via the manager's `onStateChange` dep — see
 * {@link makeUpdaterStatePush} — so it survives window recreation.)
 */
export function registerUpdaterIpc(deps: UpdaterIpcDeps): () => void {
  const { manager } = deps;

  ipcMain.handle(IPC.updaterGetState, (): UpdaterState => manager.getState());
  ipcMain.handle(IPC.updaterGetSettings, (): UpdaterSettings => manager.getSettings());
  ipcMain.handle(
    IPC.updaterSetSettings,
    (_e: IpcMainInvokeEvent, patch: UpdateUpdaterSettings): UpdaterSettings => {
      const clean = updateUpdaterSettingsSchema.parse(patch ?? {});
      return manager.setSettings(clean);
    },
  );
  ipcMain.handle(IPC.updaterCheckNow, (): Promise<UpdaterState> => manager.checkNow());
  ipcMain.handle(IPC.updaterQuitAndInstall, (): void => manager.quitAndInstall());

  return () => {
    ipcMain.removeHandler(IPC.updaterGetState);
    ipcMain.removeHandler(IPC.updaterGetSettings);
    ipcMain.removeHandler(IPC.updaterSetSettings);
    ipcMain.removeHandler(IPC.updaterCheckNow);
    ipcMain.removeHandler(IPC.updaterQuitAndInstall);
  };
}

/**
 * Push updater-state changes to the renderer on {@link IPC.updaterStateChanged}.
 * Hand the returned fn to {@link UpdaterManager} via its engine `onStateChange`
 * dep. `getWindow` resolves the live window at emit time so the push survives
 * window recreation. Mirrors the PRD-7/11 status-push pattern.
 */
export function makeUpdaterStatePush(
  getWindow: () => BrowserWindow | null,
): (state: UpdaterState) => void {
  return (state: UpdaterState) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.updaterStateChanged, state);
    }
  };
}
