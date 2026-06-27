/**
 * @file IPC for the "Meeting Detected" popup. Binds the popup's two actions to
 * main:
 *   - notificationJoin (invoke): the user clicked "Join & Record". Open the join
 *     link, bring the MAIN window forward, and push `meetingStartRequest` so the
 *     main renderer starts a recording prefilled from the event via the SAME
 *     unified start+capture flow as Home/⌘N. Then hide the popup.
 *   - notificationDismiss (invoke): hide the popup.
 *
 * The popup never starts a recording itself — capture lives in the main renderer,
 * so we delegate there. Returns a disposer (mirrors registerCalendarIpc).
 */
import { ipcMain, shell, type BrowserWindow } from "electron";
import { eventStartParams } from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { NotificationPresenter } from "./window.js";

export interface NotificationIpcDeps {
  presenter: NotificationPresenter;
  /** The main app window (so "Join & Record" can surface it + drive the start). */
  getMainWindow: () => BrowserWindow | null;
}

export function registerNotificationIpc(deps: NotificationIpcDeps): () => void {
  const { presenter, getMainWindow } = deps;

  ipcMain.handle(IPC.notificationJoin, (_e, eventId: unknown) => {
    const event = presenter.get(String(eventId));
    presenter.hide();
    if (!event) return;
    if (event.joinUrl) void shell.openExternal(event.joinUrl);
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      // Drive the existing unified start flow in the main renderer (App listens
      // via window.loqui.onStartRequest → requestStart).
      main.webContents.send(IPC.meetingStartRequest, eventStartParams(event));
    }
  });

  ipcMain.handle(IPC.notificationDismiss, () => {
    presenter.hide();
  });

  return () => {
    ipcMain.removeHandler(IPC.notificationJoin);
    ipcMain.removeHandler(IPC.notificationDismiss);
  };
}
