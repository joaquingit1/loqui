/**
 * PRD-8 — updater manager tests (timer + settings sink; injected interval seam).
 * Asserts auto-check fires an initial check + arms the interval, that disabling
 * auto-check disarms it, that the interval is floored, and that "check now" works
 * regardless of the auto-check setting.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MIN_UPDATE_CHECK_INTERVAL_MS,
  updaterSettingsSchema,
  type UpdaterSettings,
} from "@loqui/shared";
import { UpdaterManager, type UpdaterManagerDeps } from "./manager.js";

class FakeSettings {
  private s: UpdaterSettings;
  constructor(init: Partial<UpdaterSettings> = {}) {
    this.s = updaterSettingsSchema.parse(init);
  }
  getUpdaterSettings(): UpdaterSettings {
    return this.s;
  }
  setUpdaterSettings(patch: Partial<UpdaterSettings>): UpdaterSettings {
    this.s = updaterSettingsSchema.parse({ ...this.s, ...patch });
    return this.s;
  }
}

function makeManager(settings: FakeSettings, fetchManifest = vi.fn(async () => ({ version: "1.0.0", platforms: {} }))) {
  const armed: number[] = [];
  let cleared = 0;
  const deps: UpdaterManagerDeps = {
    settings,
    currentVersion: "1.0.0",
    platform: "win32",
    arch: "x64",
    fetchManifest,
    stagingDir: "/tmp/none",
    helperInput: () => ({
      platform: "win32",
      helperScript: "h.ps1",
      parentPid: 1,
      installPath: "i",
      relaunchTarget: "r",
    }),
    quit: vi.fn(),
    setInterval: ((cb: () => void, ms: number) => {
      armed.push(ms);
      return { __cb: cb } as unknown as ReturnType<typeof setInterval>;
    }) as UpdaterManagerDeps["setInterval"],
    clearInterval: (() => {
      cleared += 1;
    }) as UpdaterManagerDeps["clearInterval"],
  };
  return { manager: new UpdaterManager(deps), armed, getCleared: () => cleared, fetchManifest };
}

describe("UpdaterManager", () => {
  it("auto-check ON: kicks an initial check and arms the interval (floored)", async () => {
    const settings = new FakeSettings({ autoCheck: true, intervalMs: 60_000 });
    const { manager, armed, fetchManifest } = makeManager(settings);
    manager.start();
    // Initial check ran.
    await Promise.resolve();
    expect(fetchManifest).toHaveBeenCalledOnce();
    // Interval armed, floored at the minimum.
    expect(armed).toEqual([MIN_UPDATE_CHECK_INTERVAL_MS]);
  });

  it("auto-check OFF: does not check on launch and arms no timer", () => {
    const settings = new FakeSettings({ autoCheck: false });
    const { manager, armed, fetchManifest } = makeManager(settings);
    manager.start();
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(armed).toEqual([]);
  });

  it("disabling auto-check live disarms the timer; re-enabling re-arms it", () => {
    const settings = new FakeSettings({ autoCheck: true, intervalMs: 99 * 60_000 });
    const { manager, armed, getCleared } = makeManager(settings);
    manager.start();
    expect(armed).toHaveLength(1);
    manager.setSettings({ autoCheck: false });
    expect(getCleared()).toBeGreaterThanOrEqual(1);
    manager.setSettings({ autoCheck: true });
    expect(armed).toHaveLength(2);
    expect(armed[1]).toBe(99 * 60_000); // above the floor, used as-is
  });

  it("check now works regardless of the auto-check setting", async () => {
    const settings = new FakeSettings({ autoCheck: false });
    const { manager, fetchManifest } = makeManager(settings);
    await manager.checkNow();
    expect(fetchManifest).toHaveBeenCalledOnce();
    expect(manager.getState().phase).toBe("up-to-date");
  });

  it("setSettings persists through the sink", () => {
    const settings = new FakeSettings({ autoCheck: true });
    const { manager } = makeManager(settings);
    const merged = manager.setSettings({ intervalMs: 12_345_678 });
    expect(merged.intervalMs).toBe(12_345_678);
    expect(settings.getUpdaterSettings().intervalMs).toBe(12_345_678);
  });
});
