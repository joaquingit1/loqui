/**
 * PRD-11 — the menubar/tray app surface.
 *
 * Builds the Electron `Tray` with quick controls (start/stop, open window,
 * status, recent meetings), a recording-state icon (idle vs recording vs the
 * silence countdown), an `ask`-prompt accept action, and a launch-at-login
 * toggle (`app.setLoginItemSettings`). It is a THIN view over:
 *   - the PRD-3 lifecycle (manual start/stop — REUSED, never reimplemented),
 *   - the {@link AutoRecordEngine} state (icon/menu reflect detection),
 *   - the {@link SettingsStore} (launch-at-login + run-in-background).
 *
 * ## Testability
 * Every Electron dependency (`Tray`/`Menu`/`nativeImage`/`app`) is injected via
 * {@link TrayElectron} so the menu wiring + icon swap + login-item toggle are
 * asserted with mocks (no Electron runtime). Production injects the real modules.
 *
 * INVARIANT: the tray NEVER blocks manual control — start/stop go through the
 * same controller the IPC path uses, and the menu remains usable regardless of
 * detection state.
 */
import type { AutoRecordState, AutoRecordSettings, Meeting } from "@loqui/shared";

/** A single recent-meeting entry shown in the tray submenu. */
export interface TrayRecentMeeting {
  id: string;
  title: string;
}

/** The data the tray renders each rebuild (resolved by the host each time). */
export interface TrayModel {
  state: AutoRecordState;
  autoRecord?: Pick<AutoRecordSettings, "enabled" | "onDetect">;
  recentMeetings: TrayRecentMeeting[];
  launchAtLogin: boolean;
}

/** The actions the tray menu invokes (wired to the lifecycle + engine + window). */
export interface TrayActions {
  /** Start a meeting now (manual — REUSES the PRD-3 lifecycle). */
  startMeeting(): void | Promise<void>;
  /** Stop the active meeting now (manual — REUSES the PRD-3 lifecycle). */
  stopMeeting(): void | Promise<void>;
  /** Accept a pending `ask`-policy auto-record prompt (start the detected meeting). */
  acceptPendingStart(): void | Promise<void>;
  /** Toggle auto-record detection on/off. */
  setAutoRecordEnabled(enabled: boolean): void;
  /** Set the detection policy (`ask` prompt vs immediate auto-start). */
  setAutoRecordOnDetect(onDetect: AutoRecordSettings["onDetect"]): void;
  /** Show / focus the main window (recreating it if all are closed). */
  openWindow(): void;
  /** Open a recent meeting in the main window. */
  openMeeting(id: string): void;
  /** Toggle launch-at-login (persists the setting + calls setLoginItemSettings). */
  setLaunchAtLogin(enabled: boolean): void;
  /** Quit the app. */
  quit(): void;
}

// --- Injectable Electron surface (so the tray is unit-testable) ---------------

export interface TrayInstance {
  setImage(image: unknown): void;
  setToolTip(tip: string): void;
  setContextMenu(menu: unknown): void;
  destroy(): void;
  on(event: string, listener: () => void): void;
}

export interface TrayMenuItem {
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "submenu";
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
  submenu?: TrayMenuItem[];
}

export interface TrayElectron {
  createTray(image: unknown): TrayInstance;
  buildMenu(template: TrayMenuItem[]): unknown;
  /** Build a (possibly empty) nativeImage from a name/state; returns an opaque image. */
  iconFor(state: "idle" | "recording" | "countdown"): unknown;
  /** Persist the OS login-item setting. */
  setLoginItemSettings(enabled: boolean): void;
}

export interface TrayController {
  /** Rebuild the tooltip + icon + menu from the current model. */
  update(model: TrayModel): void;
  /** Tear down the tray. Idempotent. */
  destroy(): void;
}

/** The icon state derived from the auto-record runtime phase. */
export function iconStateFor(state: AutoRecordState): "idle" | "recording" | "countdown" {
  if (state.phase === "countdown") return "countdown";
  if (state.recording) return "recording";
  return "idle";
}

/** A short, human tooltip for the tray, reflecting the current phase. */
export function tooltipFor(state: AutoRecordState): string {
  switch (state.phase) {
    case "recording":
      return state.autoStarted ? "Loqui — recording (auto)" : "Loqui — recording";
    case "countdown":
      return `Loqui — stopping in ${state.silenceCountdownSec ?? 0}s (silence)`;
    case "detected":
      return "Loqui — meeting detected";
    case "idle":
      return "Loqui — watching for meetings";
    default:
      return "Loqui";
  }
}

/**
 * Build the tray context-menu template from the model + actions. PURE (no
 * Electron) so the menu structure + each item's wiring is unit-tested directly.
 */
export function buildTrayTemplate(
  model: TrayModel,
  actions: TrayActions,
): TrayMenuItem[] {
  const { state, recentMeetings, launchAtLogin } = model;
  const autoRecord = model.autoRecord ?? { enabled: state.enabled, onDetect: "ask" };
  const recording = state.recording;
  const detected = state.phase === "detected";

  const template: TrayMenuItem[] = [];

  // Status line (disabled — informational).
  template.push({ label: tooltipFor(state), enabled: false });
  template.push({ type: "separator" });

  // Accept a pending ask-prompt, when one is up.
  if (detected) {
    template.push({
      label: "Start detected meeting",
      click: () => void actions.acceptPendingStart(),
    });
  }

  // Start / stop (manual — always available; never blocked by detection).
  if (recording) {
    template.push({ label: "Stop recording", click: () => void actions.stopMeeting() });
  } else {
    template.push({ label: "Start recording", click: () => void actions.startMeeting() });
  }

  template.push({ label: "Open Loqui", click: () => actions.openWindow() });

  template.push({ type: "separator" });

  template.push({
    label: "Auto-record",
    type: "checkbox",
    checked: autoRecord.enabled,
    click: () => actions.setAutoRecordEnabled(!autoRecord.enabled),
  });
  template.push({
    label: "Ask before recording",
    type: "checkbox",
    checked: autoRecord.onDetect === "ask",
    click: () => actions.setAutoRecordOnDetect("ask"),
  });
  template.push({
    label: "Record automatically",
    type: "checkbox",
    checked: autoRecord.onDetect === "auto",
    click: () => actions.setAutoRecordOnDetect("auto"),
  });

  template.push({ type: "separator" });

  // Recent meetings submenu.
  template.push({
    label: "Recent meetings",
    type: "submenu",
    enabled: recentMeetings.length > 0,
    submenu:
      recentMeetings.length > 0
        ? recentMeetings.map((m) => ({
            label: m.title || "(untitled)",
            click: () => actions.openMeeting(m.id),
          }))
        : [{ label: "No recent meetings", enabled: false }],
  });

  template.push({ type: "separator" });

  // Launch-at-login toggle.
  template.push({
    label: "Launch at login",
    type: "checkbox",
    checked: launchAtLogin,
    click: () => actions.setLaunchAtLogin(!launchAtLogin),
  });

  template.push({ type: "separator" });
  template.push({ label: "Quit Loqui", click: () => actions.quit() });

  return template;
}

/**
 * Create the tray controller. Builds the Tray once (wiring a left-click to open
 * the window) and re-renders icon/tooltip/menu on each {@link TrayController.update}.
 */
export function createTray(
  electron: TrayElectron,
  actions: TrayActions,
  initial: TrayModel,
): TrayController {
  const tray = electron.createTray(electron.iconFor(iconStateFor(initial.state)));
  // Left-click opens the window (common menubar affordance).
  tray.on("click", () => actions.openWindow());

  function update(model: TrayModel): void {
    tray.setImage(electron.iconFor(iconStateFor(model.state)));
    tray.setToolTip(tooltipFor(model.state));
    tray.setContextMenu(electron.buildMenu(buildTrayTemplate(model, actions)));
  }

  // Initial render.
  update(initial);

  let destroyed = false;
  return {
    update(model: TrayModel): void {
      if (destroyed) return;
      update(model);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        tray.destroy();
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Build the real {@link TrayElectron} from the Electron modules. Kept tiny so the
 * Electron coupling is isolated to one place. Icons are simple
 * `nativeImage.createFromNamedImage` / empty fallbacks — a missing asset
 * degrades to an empty image (the tray still works), never a crash.
 */
export function createTrayElectron(deps: {
  Tray: new (image: never) => TrayInstance;
  Menu: { buildFromTemplate(template: never): unknown };
  nativeImage: { createEmpty(): unknown };
  app: { setLoginItemSettings(settings: { openAtLogin: boolean }): void };
  /** Resolve an icon image for a state (a PNG path -> nativeImage, or empty). */
  resolveIcon?: (state: "idle" | "recording" | "countdown") => unknown;
}): TrayElectron {
  const { Tray, Menu, nativeImage, app, resolveIcon } = deps;
  return {
    createTray: (image) => new Tray(image as never),
    buildMenu: (template) => Menu.buildFromTemplate(template as never),
    iconFor: (state) => resolveIcon?.(state) ?? nativeImage.createEmpty(),
    setLoginItemSettings: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
  };
}

export type { AutoRecordState, AutoRecordSettings, Meeting };
