/**
 * PRD-15 — Calendar IPC registration (main side). FOUNDATION STUB.
 *
 * The single place main binds the `window.loqui.calendar` surface (defined in
 * src/preload/index.ts) to the {@link CalendarService}, and pushes
 * `calendar:updated` to the renderer. Build unit A replaces the stub bodies with
 * the real service-backed handlers (list/connect/disconnect/getConnections/
 * refresh) + the onUpdated push wiring; the SIGNATURES + channel bindings here
 * are the contract.
 *
 * Channels (from src/shared/ipc.ts):
 *   - calendarListToday (invoke)       : today's events, soonest-first.
 *   - calendarListUpcoming (invoke)    : upcoming-window events.
 *   - calendarConnect (invoke)         : run OAuth connect flow + persist tokens.
 *   - calendarDisconnect (invoke)      : clear an account's keychain tokens.
 *   - calendarGetConnections (invoke)  : list connected accounts (no tokens).
 *   - calendarRefresh (invoke)         : force a re-sync.
 *   - calendarUpdated (push)           : event set changed.
 *
 * READ-ONLY: every channel reads scheduled events or manages connections/tokens
 * — none writes a calendar or a transcript file. Tokens never reach the renderer.
 * Mirrors registerMcpIpc / registerChatIpc: returns a disposer.
 */
import { ipcMain } from "electron";
import {
  calendarConnectParamsSchema,
  calendarDisconnectParamsSchema,
  listUpcomingParamsSchema,
  type CalendarConnection,
  type CalendarConnectResult,
  type CalendarEvent,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { CalendarIpcDeps } from "./types.js";

/**
 * Register the calendar invoke handlers + the `calendar:updated` push. Returns a
 * disposer. FOUNDATION STUB — handlers delegate to the injected
 * {@link CalendarService}; Build unit A owns the service implementation.
 */
export function registerCalendarIpc(deps: CalendarIpcDeps): () => void {
  const { service, getWindow } = deps;

  ipcMain.handle(IPC.calendarListToday, (): Promise<CalendarEvent[]> => service.listToday());
  ipcMain.handle(IPC.calendarListUpcoming, (_e, params: unknown): Promise<CalendarEvent[]> =>
    service.listUpcoming(listUpcomingParamsSchema.parse(params ?? {})),
  );
  ipcMain.handle(IPC.calendarConnect, (_e, params: unknown): Promise<CalendarConnectResult> => {
    const { provider } = calendarConnectParamsSchema.parse(params ?? {});
    return service.connect(provider);
  });
  ipcMain.handle(IPC.calendarDisconnect, (_e, params: unknown): Promise<void> => {
    const { provider, account } = calendarDisconnectParamsSchema.parse(params ?? {});
    return service.disconnect(provider, account);
  });
  ipcMain.handle(IPC.calendarGetConnections, (): Promise<CalendarConnection[]> =>
    service.getConnections(),
  );
  ipcMain.handle(IPC.calendarRefresh, (): Promise<CalendarEvent[]> => service.refresh());

  // Push the refreshed event set to whatever window is live at emit time.
  const unsubscribe = service.onUpdated((events: CalendarEvent[]) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.calendarUpdated, events);
    }
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC.calendarListToday);
    ipcMain.removeHandler(IPC.calendarListUpcoming);
    ipcMain.removeHandler(IPC.calendarConnect);
    ipcMain.removeHandler(IPC.calendarDisconnect);
    ipcMain.removeHandler(IPC.calendarGetConnections);
    ipcMain.removeHandler(IPC.calendarRefresh);
  };
}
