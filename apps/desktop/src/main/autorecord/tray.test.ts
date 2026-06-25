/**
 * Hermetic tests for the menubar/tray (PRD-11).
 *
 * Electron's Tray/Menu/nativeImage/app are MOCKED via the injectable
 * {@link TrayElectron} (no Electron runtime). Covers: the menu template wires
 * start/stop/open/recent/accept to the right actions; the icon swaps with the
 * recording state; the launch-at-login checkbox toggles via setLoginItemSettings;
 * and the start/stop label flips with the recording state.
 */
import { describe, expect, it, vi } from "vitest";
import { autoRecordStateSchema, type AutoRecordState } from "@loqui/shared";
import {
  buildTrayTemplate,
  createTray,
  iconStateFor,
  tooltipFor,
  type TrayActions,
  type TrayElectron,
  type TrayInstance,
  type TrayMenuItem,
  type TrayModel,
} from "./tray.js";

function state(over: Partial<AutoRecordState> = {}): AutoRecordState {
  return autoRecordStateSchema.parse({ enabled: true, phase: "idle", ...over });
}

function noopActions(): TrayActions {
  return {
    startMeeting: vi.fn(),
    stopMeeting: vi.fn(),
    acceptPendingStart: vi.fn(),
    setAutoRecordEnabled: vi.fn(),
    setAutoRecordOnDetect: vi.fn(),
    openWindow: vi.fn(),
    openMeeting: vi.fn(),
    setLaunchAtLogin: vi.fn(),
    quit: vi.fn(),
  };
}

/** Flatten a menu template to its top-level labels (skipping separators). */
function labels(template: TrayMenuItem[]): string[] {
  return template.filter((i) => i.type !== "separator").map((i) => i.label ?? "");
}

function find(template: TrayMenuItem[], label: string): TrayMenuItem | undefined {
  return template.find((i) => i.label === label);
}

describe("iconStateFor / tooltipFor", () => {
  it("maps phase to icon state", () => {
    expect(iconStateFor(state({ phase: "idle" }))).toBe("idle");
    expect(iconStateFor(state({ phase: "recording", recording: true }))).toBe("recording");
    expect(iconStateFor(state({ phase: "countdown", recording: true }))).toBe("countdown");
  });

  it("includes the silence countdown in the tooltip", () => {
    expect(
      tooltipFor(state({ phase: "countdown", recording: true, silenceCountdownSec: 12 })),
    ).toContain("12s");
  });
});

describe("buildTrayTemplate — wiring", () => {
  it("shows Start recording when idle and wires it to startMeeting", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      { state: state({ phase: "idle" }), recentMeetings: [], launchAtLogin: false },
      actions,
    );
    expect(labels(template)).toContain("Start recording");
    find(template, "Start recording")!.click!();
    expect(actions.startMeeting).toHaveBeenCalled();
  });

  it("shows Stop recording while recording and wires it to stopMeeting", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      { state: state({ phase: "recording", recording: true }), recentMeetings: [], launchAtLogin: false },
      actions,
    );
    expect(labels(template)).toContain("Stop recording");
    expect(labels(template)).not.toContain("Start recording");
    find(template, "Stop recording")!.click!();
    expect(actions.stopMeeting).toHaveBeenCalled();
  });

  it("offers Start detected meeting in the `detected` phase, wired to accept", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      { state: state({ phase: "detected" }), recentMeetings: [], launchAtLogin: false },
      actions,
    );
    find(template, "Start detected meeting")!.click!();
    expect(actions.acceptPendingStart).toHaveBeenCalled();
  });

  it("wires Open Loqui to openWindow", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      { state: state(), recentMeetings: [], launchAtLogin: false },
      actions,
    );
    find(template, "Open Loqui")!.click!();
    expect(actions.openWindow).toHaveBeenCalled();
  });

  it("lists recent meetings and opens one by id", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      {
        state: state(),
        recentMeetings: [
          { id: "a", title: "Standup" },
          { id: "b", title: "1:1" },
        ],
        launchAtLogin: false,
      },
      actions,
    );
    const recent = find(template, "Recent meetings")!;
    expect(recent.submenu).toHaveLength(2);
    recent.submenu![0]!.click!();
    expect(actions.openMeeting).toHaveBeenCalledWith("a");
  });

  it("toggles launch-at-login (checkbox reflects current, click flips it)", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      { state: state(), recentMeetings: [], launchAtLogin: true },
      actions,
    );
    const item = find(template, "Launch at login")!;
    expect(item.type).toBe("checkbox");
    expect(item.checked).toBe(true);
    item.click!();
    expect(actions.setLaunchAtLogin).toHaveBeenCalledWith(false);
  });

  it("toggles auto-record and exposes the ask/auto policy choice", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      {
        state: state(),
        autoRecord: { enabled: false, onDetect: "ask" },
        recentMeetings: [],
        launchAtLogin: false,
      },
      actions,
    );
    const autoRecord = find(template, "Auto-record")!;
    expect(autoRecord.type).toBe("checkbox");
    expect(autoRecord.checked).toBe(false);
    autoRecord.click!();
    expect(actions.setAutoRecordEnabled).toHaveBeenCalledWith(true);

    expect(find(template, "Ask before recording")!.checked).toBe(true);
    find(template, "Record automatically")!.click!();
    expect(actions.setAutoRecordOnDetect).toHaveBeenCalledWith("auto");
  });

  it("wires Quit Loqui to quit", () => {
    const actions = noopActions();
    const template = buildTrayTemplate(
      { state: state(), recentMeetings: [], launchAtLogin: false },
      actions,
    );
    find(template, "Quit Loqui")!.click!();
    expect(actions.quit).toHaveBeenCalled();
  });
});

// --- createTray with a mocked Electron surface --------------------------------

function fakeTrayElectron(): {
  electron: TrayElectron;
  instance: { images: unknown[]; tooltips: string[]; menus: unknown[]; destroyed: boolean; clickHandler: (() => void) | null };
  loginCalls: boolean[];
} {
  const instance = {
    images: [] as unknown[],
    tooltips: [] as string[],
    menus: [] as unknown[],
    destroyed: false,
    clickHandler: null as (() => void) | null,
  };
  const trayInstance: TrayInstance = {
    setImage: (img) => instance.images.push(img),
    setToolTip: (t) => instance.tooltips.push(t),
    setContextMenu: (m) => instance.menus.push(m),
    destroy: () => {
      instance.destroyed = true;
    },
    on: (event, listener) => {
      if (event === "click") instance.clickHandler = listener;
    },
  };
  const loginCalls: boolean[] = [];
  const electron: TrayElectron = {
    createTray: () => trayInstance,
    buildMenu: (template) => template,
    iconFor: (s) => `icon:${s}`,
    setLoginItemSettings: (enabled) => loginCalls.push(enabled),
  };
  return { electron, instance, loginCalls };
}

describe("createTray — icon swap + lifecycle", () => {
  function model(over: Partial<AutoRecordState> = {}): TrayModel {
    return {
      state: state(over),
      autoRecord: { enabled: true, onDetect: "ask" },
      recentMeetings: [],
      launchAtLogin: false,
    };
  }

  it("renders an initial icon + tooltip + menu, and opens on left-click", () => {
    const { electron, instance } = fakeTrayElectron();
    const actions = noopActions();
    createTray(electron, actions, model());
    expect(instance.images[0]).toBe("icon:idle");
    expect(instance.tooltips).toHaveLength(1);
    expect(instance.menus).toHaveLength(1);
    instance.clickHandler!();
    expect(actions.openWindow).toHaveBeenCalled();
  });

  it("swaps the icon when the recording state changes", () => {
    const { electron, instance } = fakeTrayElectron();
    const tray = createTray(electron, noopActions(), model());
    tray.update(model({ phase: "recording", recording: true }));
    expect(instance.images.at(-1)).toBe("icon:recording");
    tray.update(model({ phase: "countdown", recording: true, silenceCountdownSec: 5 }));
    expect(instance.images.at(-1)).toBe("icon:countdown");
  });

  it("destroy() tears down the tray and is idempotent", () => {
    const { electron, instance } = fakeTrayElectron();
    const tray = createTray(electron, noopActions(), model());
    tray.destroy();
    tray.destroy();
    expect(instance.destroyed).toBe(true);
    // After destroy, update is a no-op (no new images pushed).
    const before = instance.images.length;
    tray.update(model({ phase: "recording", recording: true }));
    expect(instance.images.length).toBe(before);
  });
});
