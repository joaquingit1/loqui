/**
 * Hermetic tests for the PRD-13 export IPC bridge.
 *
 * `electron` is mocked with a fake `ipcMain` so the bound handler can be invoked
 * directly (no Electron runtime). Asserts:
 *   - `exportMeeting` validates its payload + delegates to the service;
 *   - the handler is removed on dispose.
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

function setup() {
  const settings = new SettingsStore();
  // A minimal read-only export store fake (exportMeeting itself is exercised in
  // service.test.ts; here we only assert the IPC wiring + payload validation).
  const exportService = new ExportService({
    store: {
      getMeeting: () => null,
      getDiarizedTranscript: () => null,
      getTranscript: () => "",
      getSummary: () => null,
    },
    getExportDir: () => settings.getExportDir(),
  });
  const dispose = registerExportIpc({ exportService });
  return { dispose };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.handle.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args);
}

describe("registerExportIpc", () => {
  it("rejects a malformed export request payload", async () => {
    const { dispose } = setup();
    await expect(
      Promise.resolve().then(() => invoke(IPC.exportMeeting, { format: "md" })),
    ).rejects.toBeTruthy();
    dispose();
  });

  it("removes the export handler on dispose", () => {
    const { dispose } = setup();
    dispose();
    expect(handlers.removedHandlers).toEqual(expect.arrayContaining([IPC.exportMeeting]));
  });
});
