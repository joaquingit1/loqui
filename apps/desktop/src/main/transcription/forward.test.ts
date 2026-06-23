/**
 * Main-process transcript forwarding tests (node env). HERMETIC: no Electron,
 * no sidecar, no network — the supervisor's notification fan-out is mocked and
 * the renderer window is a tiny fake. Covers: filter to the transcriptSegment
 * event, drop-malformed, default normalization, mic/system independence,
 * window-recreation survival, destroyed-window skip, unsubscribe, and the
 * throwing-sink guard.
 */
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_SEGMENT_EVENT, type TranscriptSegment } from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import {
  forwardTranscriptSegments,
  parseTranscriptSegment,
  pushTranscriptSegmentsToWindow,
  windowSink,
  type TranscriptSupervisor,
} from "./forward.js";

const MEETING = "11111111-1111-4111-8111-111111111111";

/** A controllable fake of the supervisor's notification fan-out. */
function makeFakeSupervisor(): {
  supervisor: TranscriptSupervisor;
  emit: (event: string, data: unknown) => void;
  subscriberCount: () => number;
} {
  const listeners = new Set<(event: string, data: unknown) => void>();
  const supervisor: TranscriptSupervisor = {
    onNotification: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  return {
    supervisor,
    emit: (event, data) => {
      // Mirror the supervisor's real fan-out: snapshot so unsubscribe-on-emit
      // is safe.
      for (const cb of [...listeners]) cb(event, data);
    },
    subscriberCount: () => listeners.size,
  };
}

function seg(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    meetingId: MEETING,
    source: "mic",
    text: "hello",
    tStart: 0,
    tEnd: 1,
    status: "partial",
    segId: "s1",
    ...overrides,
  };
}

describe("forwardTranscriptSegments", () => {
  it("forwards a valid transcriptSegment notification to the sink", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    const sink = vi.fn();
    forwardTranscriptSegments(supervisor, sink);

    emit(TRANSCRIPT_SEGMENT_EVENT, seg());

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      meetingId: MEETING,
      source: "mic",
      text: "hello",
      status: "partial",
      segId: "s1",
    });
  });

  it("ignores notifications for other events (e.g. jobUpdate)", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    const sink = vi.fn();
    forwardTranscriptSegments(supervisor, sink);

    emit("jobUpdate", { jobId: "j1", kind: "summary", state: "running" });
    emit("somethingElse", seg());

    expect(sink).not.toHaveBeenCalled();
  });

  it("drops a malformed payload (bad meetingId) and never forwards it", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    const sink = vi.fn();
    forwardTranscriptSegments(supervisor, sink);

    emit(TRANSCRIPT_SEGMENT_EVENT, { meetingId: "not-a-uuid", source: "mic", segId: "s1" });
    emit(TRANSCRIPT_SEGMENT_EVENT, { source: "mic", segId: "s1" }); // missing meetingId
    emit(TRANSCRIPT_SEGMENT_EVENT, { meetingId: MEETING, source: "mic" }); // missing segId
    emit(TRANSCRIPT_SEGMENT_EVENT, null);
    emit(TRANSCRIPT_SEGMENT_EVENT, "garbage");

    expect(sink).not.toHaveBeenCalled();
  });

  it("normalizes defaults (text/tStart/tEnd/status) on a minimal valid segment", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    const sink = vi.fn();
    forwardTranscriptSegments(supervisor, sink);

    emit(TRANSCRIPT_SEGMENT_EVENT, { meetingId: MEETING, source: "system", segId: "s7" });

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toEqual({
      meetingId: MEETING,
      source: "system",
      text: "",
      tStart: 0,
      tEnd: 0,
      status: "partial",
      segId: "s7",
    });
  });

  it("keeps mic and system segments independent (only source tags them)", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    const sink = vi.fn();
    forwardTranscriptSegments(supervisor, sink);

    emit(TRANSCRIPT_SEGMENT_EVENT, seg({ source: "mic", segId: "m1", text: "you" }));
    emit(TRANSCRIPT_SEGMENT_EVENT, seg({ source: "system", segId: "t1", text: "them" }));

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]![0].source).toBe("mic");
    expect(sink.mock.calls[1]![0].source).toBe("system");
  });

  it("stops forwarding after unsubscribe", () => {
    const { supervisor, emit, subscriberCount } = makeFakeSupervisor();
    const sink = vi.fn();
    const off = forwardTranscriptSegments(supervisor, sink);

    emit(TRANSCRIPT_SEGMENT_EVENT, seg());
    expect(sink).toHaveBeenCalledTimes(1);

    off();
    expect(subscriberCount()).toBe(0);
    emit(TRANSCRIPT_SEGMENT_EVENT, seg());
    expect(sink).toHaveBeenCalledTimes(1); // unchanged
  });

  it("does not let a throwing sink break the fan-out loop", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    forwardTranscriptSegments(supervisor, () => {
      throw new Error("boom");
    });
    expect(() => emit(TRANSCRIPT_SEGMENT_EVENT, seg())).not.toThrow();
  });
});

describe("parseTranscriptSegment", () => {
  it("returns the parsed segment for valid data and null for malformed", () => {
    expect(parseTranscriptSegment(seg())).toMatchObject({ segId: "s1" });
    expect(parseTranscriptSegment({ meetingId: "x" })).toBeNull();
  });
});

/** A tiny fake of the bits of BrowserWindow the sink touches. */
function fakeWindow(): {
  win: { isDestroyed(): boolean; webContents: { send: ReturnType<typeof vi.fn> } };
  destroy: () => void;
} {
  let destroyed = false;
  return {
    win: {
      isDestroyed: () => destroyed,
      webContents: { send: vi.fn() },
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

describe("windowSink / pushTranscriptSegmentsToWindow", () => {
  it("sends the validated segment to the live window on the transcript channel", () => {
    const { win } = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = windowSink(() => win as any);
    sink(seg({ segId: "abc" }));
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(
      IPC.transcriptSegment,
      expect.objectContaining({ segId: "abc" }),
    );
  });

  it("skips a destroyed or absent window", () => {
    const { win, destroy } = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sink = windowSink(() => win as any);
    destroy();
    sink(seg());
    expect(win.webContents.send).not.toHaveBeenCalled();

    const nullSink = windowSink(() => null);
    expect(() => nullSink(seg())).not.toThrow();
  });

  it("resolves the window at emit time (survives window recreation)", () => {
    const { supervisor, emit } = makeFakeSupervisor();
    let current: ReturnType<typeof fakeWindow>["win"] | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pushTranscriptSegmentsToWindow(supervisor, () => current as any);

    // No window yet → dropped without error.
    emit(TRANSCRIPT_SEGMENT_EVENT, seg({ segId: "before" }));

    // A window appears later (recreated) → subsequent segments reach it.
    const fresh = fakeWindow();
    current = fresh.win;
    emit(TRANSCRIPT_SEGMENT_EVENT, seg({ segId: "after" }));

    expect(fresh.win.webContents.send).toHaveBeenCalledTimes(1);
    expect(fresh.win.webContents.send).toHaveBeenCalledWith(
      IPC.transcriptSegment,
      expect.objectContaining({ segId: "after" }),
    );
  });
});
