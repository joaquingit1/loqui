/**
 * useMeetingController tests (jsdom). HERMETIC: no window.loqui, no Electron, no
 * devices — the library bridge + capture control are injected as fakes. Covers:
 * start triggers startMeeting + capture.startAll; stop triggers capture.stopAll +
 * stopMeeting; server status pushes drive the phase; failures surface as `error`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Meeting, StartMeetingParams, StopMeetingParams } from "@loqui/shared";
import {
  useMeetingController,
  type MeetingCaptureControl,
  type MeetingLifecycleApi,
} from "./useMeetingController.js";

afterEach(cleanup);

const ID = "44444444-4444-4444-8444-444444444444";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: ID,
    title: "",
    platform: null,
    startedAt: "2026-06-23T10:00:00.000Z",
    endedAt: null,
    status: "recording",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    createdAt: "2026-06-23T10:00:00.000Z",
    updatedAt: "2026-06-23T10:00:00.000Z",
    ...overrides,
  };
}

/** A controllable fake of the lifecycle bridge. */
function makeFakeApi(overrides: Partial<MeetingLifecycleApi> = {}): {
  api: MeetingLifecycleApi;
  emitStatus: (m: Meeting) => void;
  subscribers: () => number;
} {
  const listeners = new Set<(m: Meeting) => void>();
  const api: MeetingLifecycleApi = {
    startMeeting: vi.fn(async (_p?: StartMeetingParams) => meeting()),
    stopMeeting: vi.fn(async (_p: StopMeetingParams) =>
      meeting({ status: "processing" }),
    ),
    onMeetingStatus: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    ...overrides,
  };
  return {
    api,
    emitStatus: (m) => {
      act(() => {
        for (const cb of [...listeners]) cb(m);
      });
    },
    subscribers: () => listeners.size,
  };
}

function makeFakeCapture(): {
  capture: MeetingCaptureControl;
  startAll: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
} {
  const startAll = vi.fn(async (_id: string) => {});
  const stopAll = vi.fn(async () => {});
  return { capture: { startAll, stopAll }, startAll, stopAll };
}

describe("useMeetingController", () => {
  it("starts idle and can start", () => {
    const { api } = makeFakeApi();
    const { result } = renderHook(() => useMeetingController({ api }));
    expect(result.current.phase).toBe("idle");
    expect(result.current.canStart).toBe(true);
    expect(result.current.canStop).toBe(false);
  });

  it("start() calls startMeeting then capture.startAll with the new meeting id", async () => {
    const { api } = makeFakeApi();
    const cap = makeFakeCapture();
    const { result } = renderHook(() => useMeetingController({ api, capture: cap.capture }));

    await act(async () => {
      await result.current.start({ platform: "zoom" });
    });

    expect(api.startMeeting).toHaveBeenCalledTimes(1);
    expect(api.startMeeting).toHaveBeenCalledWith({ platform: "zoom" });
    // A normal meeting opens BOTH sources (mic + system).
    expect(cap.startAll).toHaveBeenCalledWith(ID, ["mic", "system"]);
    expect(result.current.phase).toBe("recording");
    expect(result.current.canStop).toBe(true);
    expect(result.current.meeting?.id).toBe(ID);
  });

  it("voice memo (PRD-12) starts kind:'voice-memo' MIC-ONLY (no system stream)", async () => {
    const { api } = makeFakeApi({
      startMeeting: vi.fn(async (_p?: StartMeetingParams) =>
        meeting({ kind: "voice-memo" }),
      ),
    });
    const cap = makeFakeCapture();
    const { result } = renderHook(() =>
      useMeetingController({ api, capture: cap.capture }),
    );

    await act(async () => {
      await result.current.start({ kind: "voice-memo" });
    });

    expect(api.startMeeting).toHaveBeenCalledWith({ kind: "voice-memo" });
    // MIC-ONLY: the system stream is never opened.
    expect(cap.startAll).toHaveBeenCalledWith(ID, ["mic"]);
    expect(result.current.phase).toBe("recording");
    expect(result.current.meeting?.kind).toBe("voice-memo");
  });

  it("merges defaultParams under explicit start params", async () => {
    const { api } = makeFakeApi();
    const { result } = renderHook(() =>
      useMeetingController({ api, defaultParams: { platform: "google-meet" } }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(api.startMeeting).toHaveBeenCalledWith({ platform: "google-meet" });
  });

  it("stop() tears capture down THEN calls stopMeeting and moves to processing", async () => {
    const { api } = makeFakeApi();
    const cap = makeFakeCapture();
    const { result } = renderHook(() => useMeetingController({ api, capture: cap.capture }));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.stop();
    });

    expect(cap.stopAll).toHaveBeenCalledTimes(1);
    expect(api.stopMeeting).toHaveBeenCalledWith({ id: ID });
    // capture torn down before the meeting was stopped
    const stopAllOrder = cap.stopAll.mock.invocationCallOrder[0] ?? Infinity;
    const stopMeetingOrder =
      (api.stopMeeting as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? -Infinity;
    expect(stopAllOrder).toBeLessThan(stopMeetingOrder);
    expect(result.current.phase).toBe("processing");
  });

  it("reflects server status pushes (processing → done) on the active meeting", async () => {
    const { api, emitStatus } = makeFakeApi();
    const { result } = renderHook(() => useMeetingController({ api }));
    await act(async () => {
      await result.current.start();
    });
    emitStatus(meeting({ status: "done", endedAt: "2026-06-23T10:05:00.000Z" }));
    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.meeting?.endedAt).toBe("2026-06-23T10:05:00.000Z");
    expect(result.current.canStart).toBe(true);
  });

  it("surfaces a startMeeting failure as the error phase (does not throw)", async () => {
    const { api } = makeFakeApi({
      startMeeting: vi.fn(async () => {
        throw new Error("sidecar unreachable");
      }),
    });
    const { result } = renderHook(() => useMeetingController({ api }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toContain("sidecar unreachable");
  });

  it("errors gracefully when the bridge is unavailable", async () => {
    const { result } = renderHook(() => useMeetingController({}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toContain("bridge unavailable");
  });

  it("dismiss() returns to idle from done", async () => {
    const { api, emitStatus } = makeFakeApi();
    const { result } = renderHook(() => useMeetingController({ api }));
    await act(async () => {
      await result.current.start();
    });
    emitStatus(meeting({ status: "done" }));
    await waitFor(() => expect(result.current.phase).toBe("done"));
    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    expect(result.current.meeting).toBeNull();
  });

  it("unsubscribes from the status bridge on unmount", () => {
    const { api, subscribers } = makeFakeApi();
    const { unmount } = renderHook(() => useMeetingController({ api }));
    expect(subscribers()).toBe(1);
    unmount();
    expect(subscribers()).toBe(0);
  });

  it("ignores a re-entrant start while one is in flight", async () => {
    let resolveStart: (m: Meeting) => void = () => {};
    const startMeeting = vi.fn(
      () => new Promise<Meeting>((res) => (resolveStart = res)),
    );
    const { api } = makeFakeApi({ startMeeting });
    const { result } = renderHook(() => useMeetingController({ api }));

    let first: Promise<void>;
    act(() => {
      first = result.current.start();
      // second call while the first is pending — must be a no-op
      void result.current.start();
    });
    expect(startMeeting).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStart(meeting());
      await first;
    });
    expect(result.current.phase).toBe("recording");
  });
});
