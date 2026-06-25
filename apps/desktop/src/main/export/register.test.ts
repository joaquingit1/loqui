/**
 * Hermetic tests for the PRD-13 export + privacy IPC bridge.
 *
 * `electron` is mocked with a fake `ipcMain`/`dialog` so the bound handlers can
 * be invoked directly (no Electron runtime). Asserts:
 *   - `exportMeeting` validates + delegates to the service;
 *   - `getCaptureSettings`/`setCaptureSettings` round-trip through the store, and
 *     a `contentProtection` change re-applies the window flag immediately;
 *   - `getCaptureCapability` returns the per-app filter-vs-fallback decision;
 *   - all handlers are removed on dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
  },
}));

const { registerExportIpc } = await import("./register.js");
const { ExportService } = await import("./service.js");
const { SettingsStore } = await import("../settings/store.js");
const { IPC } = await import("../../shared/ipc.js");
const { DATA_DIR_ENV } = await import("@loqui/shared");

let tmp: string;

beforeEach(() => {
  handlers.handle.clear();
  handlers.removedHandlers = [];
  tmp = mkdtempSync(join(tmpdir(), "loqui-export-ipc-"));
  process.env[DATA_DIR_ENV] = tmp;
});

afterEach(() => {
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

const probe = {
  platform: "darwin" as NodeJS.Platform,
  release: "23.4.0",
  supportsProcessTap: () => false,
};

function setup() {
  const settings = new SettingsStore();
  // A minimal read-only export store fake (no real meetings needed for the
  // settings/capability handlers; exportMeeting is exercised in service.test.ts).
  const exportService = new ExportService({
    store: {
      getMeeting: () => null,
      getDiarizedTranscript: () => null,
      getTranscript: () => "",
      getSummary: () => null,
    },
    getExportDir: () => settings.getExportDir(),
  });
  const applied: boolean[] = [];
  const dispose = registerExportIpc({
    exportService,
    settings,
    captureProbe: probe,
    applyContentProtection: (enabled) => applied.push(enabled),
  });
  return { settings, applied, dispose };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.handle.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args);
}

describe("registerExportIpc", () => {
  it("reads + patches capture settings and applies content protection on toggle", async () => {
    const { applied, dispose } = setup();

    const initial = (await invoke(IPC.getCaptureSettings)) as { contentProtection: boolean };
    expect(initial.contentProtection).toBe(true);

    const updated = (await invoke(IPC.setCaptureSettings, { contentProtection: false })) as {
      contentProtection: boolean;
    };
    expect(updated.contentProtection).toBe(false);
    // The window flag was re-applied with the new value.
    expect(applied).toEqual([false]);

    // A patch that does NOT touch contentProtection must not re-apply it.
    await invoke(IPC.setCaptureSettings, { audioRetention: "never-save" });
    expect(applied).toEqual([false]);

    dispose();
  });

  it("returns the per-app capability decision (full-loopback fallback)", async () => {
    const { settings, dispose } = setup();
    // Opt in, but the probe reports unsupported -> graceful fallback.
    settings.setCaptureSettings({ perAppAudioFilter: true });
    const cap = (await invoke(IPC.getCaptureCapability)) as { mode: string; supported: boolean };
    expect(cap.supported).toBe(false);
    expect(cap.mode).toBe("full-loopback");
    dispose();
  });

  it("rejects a malformed export request payload", async () => {
    const { dispose } = setup();
    await expect(
      Promise.resolve().then(() => invoke(IPC.exportMeeting, { format: "md" })),
    ).rejects.toBeTruthy();
    dispose();
  });

  it("removes every handler on dispose", () => {
    const { dispose } = setup();
    dispose();
    expect(handlers.removedHandlers).toEqual(
      expect.arrayContaining([
        IPC.exportMeeting,
        IPC.exportPickDir,
        IPC.getCaptureSettings,
        IPC.setCaptureSettings,
        IPC.getCaptureCapability,
      ]),
    );
  });
});
