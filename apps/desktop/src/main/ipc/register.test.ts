/**
 * Hermetic test for the core IPC bridge's delete-meeting guard.
 *
 * `electron` is mocked with a fake `ipcMain`/`dialog` so the bound handler can
 * be invoked directly (no Electron runtime). The behaviour that lives ONLY here
 * (not in the store) is the active-meeting guard: a meeting that is still
 * recording must NOT be deletable. Asserts:
 *   - a finished meeting (no/other active meeting) deletes via the store;
 *   - deleting the CURRENTLY-recording meeting throws and never touches the store;
 *   - the handler is removed on dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })) },
}));

const { registerIpcHandlers } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");

const ACTIVE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

/** Build minimal deps; only store.deleteMeeting + controller.getActiveMeeting matter here. */
function makeDeps(activeMeetingId: string | null) {
  const deleteMeeting = vi.fn((_id: string) => {});
  const getActiveMeeting = vi.fn(() =>
    activeMeetingId ? ({ id: activeMeetingId } as { id: string }) : null,
  );
  const deps = {
    supervisor: { ping: vi.fn(), getHealth: vi.fn(), onStatus: vi.fn(() => () => {}) },
    store: { deleteMeeting },
    controller: { getActiveMeeting },
    importPipeline: { importFile: vi.fn() },
  };
  // The handler only needs these two methods at call time; cast past the full
  // MeetingStore/MeetingController interfaces (registration never invokes the rest).
  return { deps: deps as never, deleteMeeting, getActiveMeeting };
}

beforeEach(() => {
  handlers.handle.clear();
  handlers.removedHandlers = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("deleteMeeting IPC guard", () => {
  it("deletes via the store when no meeting is recording", () => {
    const { deps, deleteMeeting } = makeDeps(null);
    registerIpcHandlers(deps);
    const handler = handlers.handle.get(IPC.deleteMeeting)!;
    expect(handler).toBeTypeOf("function");

    handler({}, { id: OTHER_ID });
    expect(deleteMeeting).toHaveBeenCalledWith(OTHER_ID);
  });

  it("deletes a finished meeting even while a DIFFERENT meeting records", () => {
    const { deps, deleteMeeting } = makeDeps(ACTIVE_ID);
    registerIpcHandlers(deps);
    handlers.handle.get(IPC.deleteMeeting)!({}, { id: OTHER_ID });
    expect(deleteMeeting).toHaveBeenCalledWith(OTHER_ID);
  });

  it("refuses to delete the meeting that is still recording (throws, no store call)", () => {
    const { deps, deleteMeeting } = makeDeps(ACTIVE_ID);
    registerIpcHandlers(deps);
    const handler = handlers.handle.get(IPC.deleteMeeting)!;
    expect(() => handler({}, { id: ACTIVE_ID })).toThrow(/still recording/i);
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  it("validates the params (rejects a missing id)", () => {
    const { deps, deleteMeeting } = makeDeps(null);
    registerIpcHandlers(deps);
    const handler = handlers.handle.get(IPC.deleteMeeting)!;
    expect(() => handler({}, {})).toThrow();
    expect(deleteMeeting).not.toHaveBeenCalled();
  });

  it("removes the deleteMeeting handler on dispose", () => {
    const { deps } = makeDeps(null);
    const dispose = registerIpcHandlers(deps);
    dispose();
    expect(handlers.removedHandlers).toContain(IPC.deleteMeeting);
  });
});
