/**
 * PRD-11 — the auto-record IPC bridge + state push (main side).
 *
 * Binds the `window.loqui.autoRecord` channels to the {@link AutoRecordEngine} +
 * {@link SettingsStore}, and pushes engine state changes to the live window
 * (mirrors registerSpeakerNamesIpc / registerCalendarIpc). Returns a disposer.
 *
 * Settings writes go through the store (single source of persistence) and are
 * applied to the engine live; the launch-at-login flag is reflected to the OS via
 * the injected `setLoginItemSettings` (Electron `app.setLoginItemSettings`).
 *
 * Best-effort + non-blocking: a handler never throws into the renderer beyond a
 * normal rejected invoke; nothing here can block manual start/stop.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  updateAutoRecordSettingsSchema,
  type AutoRecordSettings,
  type AutoRecordState,
  type UpdateAutoRecordSettings,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { AutoRecordEngine } from "./engine.js";

/** The settings slice the bridge needs (a slice of SettingsStore). */
export interface AutoRecordSettingsSink {
  getAutoRecordSettings(): AutoRecordSettings;
  setAutoRecordSettings(patch: UpdateAutoRecordSettings): AutoRecordSettings;
}

export interface AutoRecordIpcDeps {
  engine: Pick<
    AutoRecordEngine,
    | "getState"
    | "onStateChange"
    | "applySettings"
    | "acceptPendingStart"
    | "dismissPendingStart"
  >;
  settings: AutoRecordSettingsSink;
  /** Reflect launch-at-login to the OS (Electron app.setLoginItemSettings). */
  setLoginItemSettings: (enabled: boolean) => void;
  /** Apply run-in-background to the current process (macOS dock hide/show). */
  applyRunInBackground?: (enabled: boolean) => void;
  getWindow: () => BrowserWindow | null;
}

/**
 * Register the auto-record IPC handlers + the state push. Returns a disposer that
 * removes the handlers and unsubscribes the push.
 */
export function registerAutoRecordIpc(deps: AutoRecordIpcDeps): () => void {
  const { engine, settings, setLoginItemSettings, applyRunInBackground, getWindow } = deps;

  ipcMain.handle(IPC.autoRecordGetSettings, (): AutoRecordSettings => {
    return settings.getAutoRecordSettings();
  });

  ipcMain.handle(
    IPC.autoRecordSetSettings,
    (_e: IpcMainInvokeEvent, patch: UpdateAutoRecordSettings): AutoRecordSettings => {
      const clean = updateAutoRecordSettingsSchema.parse(patch ?? {});
      const merged = settings.setAutoRecordSettings(clean);
      // Reflect launch-at-login to the OS when it was part of the patch.
      if (clean.launchAtLogin !== undefined) {
        try {
          setLoginItemSettings(merged.launchAtLogin);
        } catch (err) {
          console.error("[loqui] auto-record: setLoginItemSettings failed:", err);
        }
      }
      if (clean.runInBackground !== undefined) {
        try {
          applyRunInBackground?.(merged.runInBackground);
        } catch (err) {
          console.error("[loqui] auto-record: apply runInBackground failed:", err);
        }
      }
      // Apply the merged settings to the engine live (starts/stops the loop).
      engine.applySettings(merged);
      return merged;
    },
  );

  ipcMain.handle(IPC.autoRecordGetState, (): AutoRecordState => {
    return engine.getState();
  });

  ipcMain.handle(IPC.autoRecordAcceptPending, async (): Promise<void> => {
    await engine.acceptPendingStart();
  });

  ipcMain.handle(IPC.autoRecordDismissPending, (): void => {
    engine.dismissPendingStart();
  });

  // Push engine state changes to the live window (badge + detection prompt).
  const unsub = engine.onStateChange((state: AutoRecordState) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.autoRecordStateChanged, state);
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.autoRecordGetSettings);
    ipcMain.removeHandler(IPC.autoRecordSetSettings);
    ipcMain.removeHandler(IPC.autoRecordGetState);
    ipcMain.removeHandler(IPC.autoRecordAcceptPending);
    ipcMain.removeHandler(IPC.autoRecordDismissPending);
    unsub();
  };
}
