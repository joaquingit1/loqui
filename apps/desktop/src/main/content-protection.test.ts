/**
 * PRD-13 content-protection test: createWindow applies
 * BrowserWindow.setContentProtection with the configured flag (OFF by default —
 * Loqui windows are screenshot-able by default; content protection is opt-in).
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
  it("disables content protection by default (screenshots work)", () => {
    FakeBrowserWindow.instances = [];
    createWindow();
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.contentProtectionCalls).toEqual([false]);
  });

  it("enables content protection when the setting is on", () => {
    FakeBrowserWindow.instances = [];
    createWindow({ contentProtection: true });
    const win = FakeBrowserWindow.instances.at(-1)!;
    expect(win.contentProtectionCalls).toEqual([true]);
  });
});
