/**
 * @file The "Meeting Detected" popup window — a small, frameless, always-on-top
 * panel pinned to the screen's top-right corner. It floats above other apps (and
 * fullscreen spaces) even when Loqui's main window is minimized or hidden, and is
 * rendered by our own React entry (`renderer/notification.html`) so it follows the
 * Loqui design system.
 *
 * The window is created once (hidden) and reused: `show(event)` pushes the event
 * to the renderer, positions + reveals it WITHOUT stealing focus, and arms an
 * auto-dismiss; `hide()` tucks it away. The presenter also remembers the shown
 * event(s) by id so the IPC "Join & Record" handler can resolve the click back to
 * a {@link CalendarEvent}. NO meeting/transcript IO happens here.
 */
import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import type { CalendarEvent } from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";

const WIDTH = 360;
const HEIGHT = 132;
const MARGIN = 16;
/** Auto-hide if the user neither joins nor dismisses (don't let it linger). */
const AUTO_DISMISS_MS = 6_000;

export interface NotificationPresenter {
  /** Show the popup for an imminent meeting (reusing the hidden window). */
  show(event: CalendarEvent): void;
  /** Hide the popup. */
  hide(): void;
  /** Resolve a shown event by id (for the "Join & Record" handler). */
  get(eventId: string): CalendarEvent | undefined;
  /** Destroy the window + clear timers. */
  dispose(): void;
}

export function createNotificationPresenter(): NotificationPresenter {
  let win: BrowserWindow | null = null;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  // Events currently surfaced, keyed by id, so the join handler can resolve them.
  const shown = new Map<string, CalendarEvent>();

  function ensureWindow(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    const isMac = process.platform === "darwin";
    const w = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Fully transparent with NO OS window shadow, so ONLY the renderer's rounded
      // glass card shows. (Vibrancy would fill the whole window rect as a square,
      // and the default OS drop-shadow would draw a square behind the card — both
      // read as "a box around the popup". The card draws its own CSS shadow.)
      transparent: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, "../preload/index.cjs"),
      },
    });
    // Float above everything, including fullscreen meetings; never join the app
    // switcher. (No content protection — Loqui windows are screenshot-able by
    // default, matching the main window.)
    w.setAlwaysOnTop(true, "screen-saver");
    if (isMac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    if (devUrl) void w.loadURL(`${devUrl}/notification.html`);
    else void w.loadFile(join(__dirname, "../renderer/notification.html"));
    w.on("closed", () => {
      if (win === w) win = null;
    });
    win = w;
    return w;
  }

  function position(w: BrowserWindow): void {
    const { workArea } = screen.getPrimaryDisplay();
    const x = workArea.x + workArea.width - WIDTH - MARGIN;
    const y = workArea.y + MARGIN;
    w.setPosition(Math.round(x), Math.round(y));
  }

  function clearDismiss(): void {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }

  function show(event: CalendarEvent): void {
    const w = ensureWindow();
    shown.set(event.id, event);
    const send = (): void => {
      if (!w.isDestroyed()) w.webContents.send(IPC.notificationMeetingDetected, event);
    };
    // Reused window is already loaded → send directly; first show may still be
    // loading → flush once the document is ready (renderer subscribes on mount).
    if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
    else send();
    position(w);
    w.showInactive(); // reveal without stealing focus from the user's current app
    clearDismiss();
    dismissTimer = setTimeout(() => hide(), AUTO_DISMISS_MS);
  }

  function hide(): void {
    clearDismiss();
    shown.clear();
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  function get(eventId: string): CalendarEvent | undefined {
    return shown.get(eventId);
  }

  function dispose(): void {
    clearDismiss();
    shown.clear();
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  // Pre-create the hidden window so it's loaded + mounted before the first alert
  // (avoids a first-show race where the push beats the renderer subscription).
  ensureWindow();

  return { show, hide, get, dispose };
}
