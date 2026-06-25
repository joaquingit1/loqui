/**
 * PRD-8 — updater IPC bridge tests. `electron` is mocked with a fake ipcMain that
 * records handlers so we invoke them directly (no Electron). Asserts each channel
 * delegates to the manager, the disposer removes every handler, and the state
 * push reaches the live window (and is safe with no / a destroyed window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updaterStateSchema, type UpdaterSettings, type UpdaterState } from "@loqui/shared";

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

const { registerUpdaterIpc, makeUpdaterStatePush } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");

const STATE: UpdaterState = updaterStateSchema.parse({ currentVersion: "1.0.0", phase: "ready" });
const SETTINGS: UpdaterSettings = {
  autoCheck: true,
  intervalMs: 1_800_000,
  autoDownload: true,
};

function makeManager() {
  return {
    getState: vi.fn((): UpdaterState => STATE),
    getSettings: vi.fn((): UpdaterSettings => SETTINGS),
    setSettings: vi.fn((patch): UpdaterSettings => ({ ...SETTINGS, ...patch })),
    checkNow: vi.fn(async (): Promise<UpdaterState> => STATE),
    quitAndInstall: vi.fn((): void => {}),
  };
}

beforeEach(() => {
  handlers.handle.clear();
  handlers.removedHandlers = [];
});
afterEach(() => vi.restoreAllMocks());

describe("registerUpdaterIpc", () => {
  it("getState delegates to the manager", () => {
    const manager = makeManager();
    registerUpdaterIpc({ manager, getWindow: () => null });
    const result = handlers.handle.get(IPC.updaterGetState)!(null) as UpdaterState;
    expect(manager.getState).toHaveBeenCalled();
    expect(result.phase).toBe("ready");
  });

  it("getSettings delegates to the manager", () => {
    const manager = makeManager();
    registerUpdaterIpc({ manager, getWindow: () => null });
    const result = handlers.handle.get(IPC.updaterGetSettings)!(null) as UpdaterSettings;
    expect(result.autoCheck).toBe(true);
  });

  it("setSettings validates the patch and delegates", () => {
    const manager = makeManager();
    registerUpdaterIpc({ manager, getWindow: () => null });
    const result = handlers.handle.get(IPC.updaterSetSettings)!(null, {
      autoCheck: false,
    }) as UpdaterSettings;
    expect(manager.setSettings).toHaveBeenCalledWith({ autoCheck: false });
    expect(result.autoCheck).toBe(false);
  });

  it("checkNow delegates and returns the resulting state", async () => {
    const manager = makeManager();
    registerUpdaterIpc({ manager, getWindow: () => null });
    const result = (await handlers.handle.get(IPC.updaterCheckNow)!(null)) as UpdaterState;
    expect(manager.checkNow).toHaveBeenCalled();
    expect(result.phase).toBe("ready");
  });

  it("quitAndInstall delegates to the manager", () => {
    const manager = makeManager();
    registerUpdaterIpc({ manager, getWindow: () => null });
    handlers.handle.get(IPC.updaterQuitAndInstall)!(null);
    expect(manager.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("the disposer removes every handler it registered", () => {
    const dispose = registerUpdaterIpc({ manager: makeManager(), getWindow: () => null });
    dispose();
    expect(handlers.removedHandlers).toEqual(
      expect.arrayContaining([
        IPC.updaterGetState,
        IPC.updaterGetSettings,
        IPC.updaterSetSettings,
        IPC.updaterCheckNow,
        IPC.updaterQuitAndInstall,
      ]),
    );
  });
});

describe("makeUpdaterStatePush", () => {
  it("pushes the state on IPC.updaterStateChanged to a live window", () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
    const push = makeUpdaterStatePush(() => win as never);
    push(STATE);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(IPC.updaterStateChanged);
    expect(sent[0]!.payload).toEqual(STATE);
  });

  it("is safe with no window / a destroyed window", () => {
    expect(() => makeUpdaterStatePush(() => null)(STATE)).not.toThrow();
    const win = { isDestroyed: () => true, webContents: { send: vi.fn() } };
    makeUpdaterStatePush(() => win as never)(STATE);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
