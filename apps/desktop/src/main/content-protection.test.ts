/**
 * PRD-13 content-protection test: createWindow applies
 * BrowserWindow.setContentProtection with the configured flag (ON by default).
 *
 * `electron` is mocked so a fake BrowserWindow records the setContentProtection
 * call — no Electron runtime, no real window. This is the most-feasible seam to
 * assert the privacy invariant (the window is excluded from screen capture).
 */
import { describe, expect, it, vi } from "vitest";

/** A fake BrowserWindow that records setContentProtection calls. */
class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  contentProtectionCalls: boolean[] = [];
  constructor(_opts: unknown) {
    FakeBrowserWindow.instances.push(this);
  }
  setContentProtection(enabled: boolean): void {
    this.contentProtectionCalls.push(enabled);
  }
  once(): void {}
  on(): void {}
  loadURL(): void {}
  loadFile(): void {}
}

vi.mock("electron", () => ({
  app: { whenReady: vi.fn(), on: vi.fn(), quit: vi.fn() },
  BrowserWindow: FakeBrowserWindow,
  safeStorage: {},
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
  shell: {},
  systemPreferences: {},
}));

const { createWindow } = await import("./index.js");

describe("createWindow content protection (PRD-13)", () => {
  it("enables content protection by default", () => {
    FakeBrowserWindow.instances = [];
    createWindow();
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.contentProtectionCalls).toEqual([true]);
  });

  it("disables content protection when the setting is off", () => {
    FakeBrowserWindow.instances = [];
    createWindow({ contentProtection: false });
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.contentProtectionCalls).toEqual([false]);
  });
});
