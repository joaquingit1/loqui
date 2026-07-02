/**
 * Hermetic tests for the audio IPC registration — the ATTEMPT-FIRST native
 * system-audio start (macOS).
 *
 * `electron` is mocked with a fake `ipcMain` that records `handle`/`on`
 * registrations so we can invoke the bound handlers directly (no Electron
 * runtime). The supervisor + native capture are fakes.
 *
 * Invariants asserted here:
 *   - a "denied" Screen Recording status must NOT short-circuit the start: on
 *     macOS `getMediaAccessStatus("screen")` reads "denied" even for an app
 *     that has NEVER been asked, and the OS permission prompt only fires from
 *     an actual ScreenCaptureKit attempt — so the helper is ALWAYS attempted;
 *   - the helper's `capture_denied` is the one authoritative refusal: it maps
 *     to `screen_permission_denied` with the actionable Screen Recording
 *     message, rolls the orchestrator source back (audioStop), and logs a
 *     console.warn (diagnosis must never be blind);
 *   - any other helper failure (e.g. the captureReady timeout) surfaces as a
 *     visible `ok:false` error + a console.warn — never silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIO_EVENT } from "@loqui/shared";
import type {
  NativeCaptureStartResult,
  NativeSystemCapture,
} from "../capture/native-system-capture.js";
import type { AudioSupervisor } from "./register.js";

// --- Fake electron ipcMain (records registrations; lets us invoke handlers) ---
const handlers = {
  on: new Map<string, (e: unknown, ...args: unknown[]) => void>(),
  handle: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
};

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (e: unknown, ...args: unknown[]) => void) => {
      handlers.on.set(channel, listener);
    },
    handle: (channel: string, listener: (e: unknown, ...args: unknown[]) => unknown) => {
      handlers.handle.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      handlers.handle.delete(channel);
    },
    removeListener: (channel: string) => {
      handlers.on.delete(channel);
    },
  },
}));

// Imported AFTER the mock so the module binds the fake ipcMain.
const { registerAudioIpc } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");

const ID = "66666666-6666-4666-8666-666666666666";

function fakeSupervisor(): AudioSupervisor & {
  sendControlNotification: ReturnType<typeof vi.fn>;
} {
  let active: string | null = null;
  return {
    sendAudioFrame: vi.fn(),
    sendControlNotification: vi.fn(),
    setActiveMeeting: vi.fn((id: string | null) => {
      active = id;
    }),
    getActiveMeeting: vi.fn(() => active),
    isConnected: vi.fn(() => true),
  };
}

function fakeNative(result: NativeCaptureStartResult): {
  capture: NativeSystemCapture;
  start: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn(async (_meetingId: string) => result);
  const capture = {
    start,
    stop: vi.fn(),
    setMuted: vi.fn(),
  } as unknown as NativeSystemCapture;
  return { capture, start };
}

describe("registerAudioIpc — attempt-first native system start", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    handlers.on.clear();
    handlers.handle.clear();
    warn.mockRestore();
  });

  function register(native: NativeSystemCapture, supervisor = fakeSupervisor()) {
    dispose = registerAudioIpc({
      supervisor,
      // The never-asked case reads "denied" on macOS — it must NOT gate the start.
      getScreenPermission: vi.fn(async () => "denied" as const),
      platform: "darwin",
      makeNativeSystemCapture: () => native,
    });
    return supervisor;
  }

  async function invokeStart(): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
    mode?: string;
  }> {
    const handler = handlers.handle.get(IPC.audioStartCapture)!;
    return (await handler(null, { meetingId: ID, source: "system" })) as never;
  }

  it("attempts the helper even when Screen Recording reads denied (no early gate)", async () => {
    const native = fakeNative({ ok: true });
    register(native.capture);

    const res = await invokeStart();

    // The attempt is what lets macOS show the permission prompt when never-asked.
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, mode: "native" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps the helper's capture_denied to screen_permission_denied, rolls back, and warns", async () => {
    const native = fakeNative({ ok: false, code: "capture_denied", message: "-3801" });
    const supervisor = register(native.capture);

    const res = await invokeStart();

    expect(res.ok).toBe(false);
    expect(res.code).toBe("screen_permission_denied");
    expect(res.message).toContain("Screen Recording");
    expect(res.message).toContain("quit and reopen");
    // Rollback: the orchestrator source was torn down (audioStart then audioStop).
    const events = supervisor.sendControlNotification.mock.calls.map((c) => c[0]);
    expect(events).toEqual([AUDIO_EVENT.start, AUDIO_EVENT.stop]);
    // LOUD refusal: the failure is logged with the helper code + OS status.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("capture_denied"));
  });

  it("surfaces a helper timeout/failure as a visible error, never silence", async () => {
    const native = fakeNative({
      ok: false,
      code: "capture_failed",
      message: "timed out waiting for captureReady",
    });
    register(native.capture);

    const res = await invokeStart();

    expect(res.ok).toBe(false);
    expect(res.code).toBe("capture_failed");
    expect(res.message).toContain("timed out");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("capture_failed"));
  });
});
