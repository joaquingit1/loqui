/**
 * Hermetic tests for the auto-record IPC bridge + state push (PRD-11).
 *
 * `electron` is mocked with a fake `ipcMain` that records `handle` registrations
 * so we invoke the bound handlers directly (no Electron runtime). The engine +
 * settings sink are fakes. Covers: settings get/set delegate to the store + apply
 * to the engine; a launchAtLogin patch calls setLoginItemSettings; state invoke
 * delegates to the engine; accept/dismiss delegate; the state push reaches the
 * live window; and the disposer removes the handlers + unsubscribes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoRecordSettingsSchema,
  autoRecordStateSchema,
  type AutoRecordSettings,
  type AutoRecordState,
  type UpdateAutoRecordSettings,
} from "@loqui/shared";
import type { AutoRecordSettingsSink } from "./register.js";

interface RecordedHandlers {
  handle: Map<string, (e: unknown, ...args: unknown[]) => unknown>;
  removedHandlers: string[];
}
const handlers: RecordedHandlers = { handle: new Map(), removedHandlers: [] };
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.handle.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.removedHandlers.push(channel);
      handlers.handle.delete(channel);
    },
  },
}));

const { registerAutoRecordIpc } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");

beforeEach(() => {
  handlers.handle.clear();
  handlers.removedHandlers = [];
});
afterEach(() => vi.restoreAllMocks());

function fakeSettings(initial?: Partial<AutoRecordSettings>): AutoRecordSettingsSink & {
  saved: AutoRecordSettings;
} {
  const sink = {
    saved: autoRecordSettingsSchema.parse(initial ?? {}),
    getAutoRecordSettings(): AutoRecordSettings {
      return sink.saved;
    },
    setAutoRecordSettings(patch: UpdateAutoRecordSettings): AutoRecordSettings {
      sink.saved = autoRecordSettingsSchema.parse({ ...sink.saved, ...patch });
      return sink.saved;
    },
  };
  return sink;
}

function fakeEngine() {
  let emit: ((s: AutoRecordState) => void) | null = null;
  return {
    applySettings: vi.fn(),
    acceptPendingStart: vi.fn(async () => {}),
    dismissPendingStart: vi.fn(),
    getState: vi.fn(() => autoRecordStateSchema.parse({ enabled: true, phase: "idle" })),
    onStateChange: (cb: (s: AutoRecordState) => void) => {
      emit = cb;
      return () => {
        emit = null;
      };
    },
    fire: (s: AutoRecordState) => emit?.(s),
  };
}

function makeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
  };
}

describe("registerAutoRecordIpc — settings", () => {
  it("getSettings delegates to the store", () => {
    const settings = fakeSettings({ enabled: true });
    registerAutoRecordIpc({
      engine: fakeEngine(),
      settings,
      setLoginItemSettings: vi.fn(),
      getWindow: () => null,
    });
    const out = handlers.handle.get(IPC.autoRecordGetSettings)!(null) as AutoRecordSettings;
    expect(out.enabled).toBe(true);
  });

  it("setSettings persists, applies to the engine, and returns the merged value", () => {
    const settings = fakeSettings();
    const engine = fakeEngine();
    registerAutoRecordIpc({ engine, settings, setLoginItemSettings: vi.fn(), getWindow: () => null });
    const out = handlers.handle.get(IPC.autoRecordSetSettings)!(null, {
      enabled: true,
      onDetect: "auto",
    }) as AutoRecordSettings;
    expect(out.enabled).toBe(true);
    expect(out.onDetect).toBe("auto");
    expect(settings.saved.enabled).toBe(true);
    expect(engine.applySettings).toHaveBeenCalledWith(out);
  });

  it("a launchAtLogin patch reflects to the OS via setLoginItemSettings", () => {
    const setLogin = vi.fn();
    registerAutoRecordIpc({
      engine: fakeEngine(),
      settings: fakeSettings(),
      setLoginItemSettings: setLogin,
      getWindow: () => null,
    });
    handlers.handle.get(IPC.autoRecordSetSettings)!(null, { launchAtLogin: true });
    expect(setLogin).toHaveBeenCalledWith(true);
  });

  it("a patch WITHOUT launchAtLogin does not touch the login item", () => {
    const setLogin = vi.fn();
    registerAutoRecordIpc({
      engine: fakeEngine(),
      settings: fakeSettings(),
      setLoginItemSettings: setLogin,
      getWindow: () => null,
    });
    handlers.handle.get(IPC.autoRecordSetSettings)!(null, { enabled: true });
    expect(setLogin).not.toHaveBeenCalled();
  });

  it("a runInBackground patch applies the dock visibility setting", () => {
    const applyRunInBackground = vi.fn();
    registerAutoRecordIpc({
      engine: fakeEngine(),
      settings: fakeSettings(),
      setLoginItemSettings: vi.fn(),
      applyRunInBackground,
      getWindow: () => null,
    });
    handlers.handle.get(IPC.autoRecordSetSettings)!(null, { runInBackground: true });
    expect(applyRunInBackground).toHaveBeenCalledWith(true);
  });
});

describe("registerAutoRecordIpc — state + actions + push", () => {
  it("getState delegates to the engine", () => {
    const engine = fakeEngine();
    registerAutoRecordIpc({ engine, settings: fakeSettings(), setLoginItemSettings: vi.fn(), getWindow: () => null });
    handlers.handle.get(IPC.autoRecordGetState)!(null);
    expect(engine.getState).toHaveBeenCalled();
  });

  it("accept/dismiss delegate to the engine", async () => {
    const engine = fakeEngine();
    registerAutoRecordIpc({ engine, settings: fakeSettings(), setLoginItemSettings: vi.fn(), getWindow: () => null });
    await handlers.handle.get(IPC.autoRecordAcceptPending)!(null);
    handlers.handle.get(IPC.autoRecordDismissPending)!(null);
    expect(engine.acceptPendingStart).toHaveBeenCalled();
    expect(engine.dismissPendingStart).toHaveBeenCalled();
  });

  it("pushes state changes to the live window", () => {
    const engine = fakeEngine();
    const win = makeWindow();
    registerAutoRecordIpc({ engine, settings: fakeSettings(), setLoginItemSettings: vi.fn(), getWindow: () => win as never });
    const state = autoRecordStateSchema.parse({ enabled: true, phase: "recording", recording: true });
    engine.fire(state);
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0]!.channel).toBe(IPC.autoRecordStateChanged);
    expect(win.sent[0]!.payload).toEqual(state);
  });

  it("does not throw when there is no live window", () => {
    const engine = fakeEngine();
    registerAutoRecordIpc({ engine, settings: fakeSettings(), setLoginItemSettings: vi.fn(), getWindow: () => null });
    expect(() => engine.fire(autoRecordStateSchema.parse({}))).not.toThrow();
  });

  it("the disposer removes the handlers and unsubscribes the push", () => {
    const engine = fakeEngine();
    const win = makeWindow();
    const dispose = registerAutoRecordIpc({
      engine,
      settings: fakeSettings(),
      setLoginItemSettings: vi.fn(),
      getWindow: () => win as never,
    });
    dispose();
    expect(handlers.removedHandlers).toContain(IPC.autoRecordGetSettings);
    expect(handlers.removedHandlers).toContain(IPC.autoRecordSetSettings);
    // After dispose, a fired state no longer reaches the window.
    engine.fire(autoRecordStateSchema.parse({ enabled: true, phase: "idle" }));
    expect(win.sent).toHaveLength(0);
  });
});
