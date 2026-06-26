/**
 * MeetingControls integration tests (jsdom). HERMETIC: window.loqui is injected
 * as a controllable fake (library + audio + onTranscriptSegment); the capture
 * controller is a fake factory so jsdom never touches getUserMedia/AudioWorklet.
 *
 * Covers the unit contract: Start triggers startMeeting + capture start; Stop
 * triggers capture stop + stopMeeting; the recording status reflects the
 * lifecycle (incl. live transcript during recording); error/disconnect states
 * are surfaced gracefully.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AudioSource,
  LoquiAudioApi,
  Meeting,
  StartMeetingParams,
  StopMeetingParams,
  TranscriptSegment,
} from "@loqui/shared";
import { MeetingControls } from "./MeetingControls.js";
import type { LoquiApi } from "../../preload/index.js";
import type {
  CaptureController,
  CaptureControllerDeps,
  CaptureStatus,
  CaptureStatusListener,
} from "../capture/index.js";

afterEach(cleanup);

const ID = "55555555-5555-4555-8555-555555555555";

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

function fakeAudio(): LoquiAudioApi {
  return {
    startCapture: vi.fn(async () => ({ ok: true })),
    stopCapture: vi.fn(async () => ({ ok: true })),
    sendFrame: vi.fn(),
    getScreenPermission: vi.fn(async () => "not-applicable" as const),
    onScreenPermission: vi.fn(() => () => {}),
  };
}

/** A controllable fake capture controller so we can drive per-source status. */
function makeFakeCaptureFactory(): {
  factory: (deps: CaptureControllerDeps) => CaptureController;
  start: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
  emit: (source: AudioSource, status: CaptureStatus) => void;
  lastMeetingId: () => string | undefined;
} {
  let listener: CaptureStatusListener | null = null;
  let lastMeetingId: string | undefined;
  const start = vi.fn(async (_s: AudioSource) => {});
  const stopAll = vi.fn(async () => {});
  const statuses: Record<AudioSource, CaptureStatus> = {
    mic: { state: "idle", level: 0 },
    system: { state: "idle", level: 0 },
  };
  const controller: CaptureController = {
    start,
    stop: vi.fn(async () => {}),
    stopAll,
    getStatus: (s) => statuses[s],
    setMuted: vi.fn(),
    toggleMute: vi.fn(() => false),
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  const factory = (deps: CaptureControllerDeps): CaptureController => {
    lastMeetingId = deps.meetingId;
    if (deps.onStatus) listener = deps.onStatus;
    return controller;
  };
  return {
    factory,
    start,
    stopAll,
    emit: (source, status) => {
      statuses[source] = status;
      act(() => listener?.(source, status));
    },
    lastMeetingId: () => lastMeetingId,
  };
}

/** A controllable fake of the full window.loqui surface MeetingControls needs. */
function makeFakeApi(overrides: Partial<LoquiApi["library"]> = {}): {
  api: Pick<LoquiApi, "library" | "audio" | "onTranscriptSegment">;
  emitStatus: (m: Meeting) => void;
  emitSegment: (seg: Partial<TranscriptSegment>) => void;
} {
  const statusListeners = new Set<(m: Meeting) => void>();
  const segListeners = new Set<(s: TranscriptSegment) => void>();
  const library: LoquiApi["library"] = {
    startMeeting: vi.fn(async (_p?: StartMeetingParams) => meeting()),
    stopMeeting: vi.fn(async (_p: StopMeetingParams) => meeting({ status: "processing" })),
    listMeetings: vi.fn(async () => []),
    searchMeetings: vi.fn(async () => []),
    getTranscript: vi.fn(async () => ""),
    renameMeeting: vi.fn(async () => meeting()),
    importFile: vi.fn(async () => meeting({ kind: "import" })),
    pickAndImportFile: vi.fn(async () => meeting({ kind: "import" })),
    onMeetingStatus: (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    ...overrides,
  };
  const api = {
    library,
    audio: fakeAudio(),
    onTranscriptSegment: (cb: (s: TranscriptSegment) => void) => {
      segListeners.add(cb);
      return () => segListeners.delete(cb);
    },
  };
  return {
    api,
    emitStatus: (m) => act(() => statusListeners.forEach((cb) => cb(m))),
    emitSegment: (overrides2) =>
      act(() =>
        segListeners.forEach((cb) =>
          cb({
            meetingId: ID,
            source: "mic",
            text: "",
            tStart: 0,
            tEnd: 0,
            status: "partial",
            segId: "s1",
            ...overrides2,
          }),
        ),
      ),
  };
}

describe("MeetingControls", () => {
  it("renders an idle Start control", () => {
    const { api } = makeFakeApi();
    render(<MeetingControls api={api} />);
    const toggle = screen.getByTestId("meeting-toggle");
    expect(toggle.textContent).toContain("Start meeting");
    expect(toggle).toHaveProperty("disabled", false);
    expect(screen.getByTestId("meeting-controls").getAttribute("data-phase")).toBe("idle");
  });

  it("Start creates+starts a meeting and begins capture for both sources", async () => {
    const { api } = makeFakeApi();
    const cap = makeFakeCaptureFactory();
    render(<MeetingControls api={api} createCaptureController={cap.factory} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });

    expect(api.library.startMeeting).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("recording-status").getAttribute("data-phase")).toBe(
        "recording",
      ),
    );
    // capture controller built for the new meeting id, both sources started.
    expect(cap.lastMeetingId()).toBe(ID);
    expect(cap.start).toHaveBeenCalledWith("mic");
    expect(cap.start).toHaveBeenCalledWith("system");
    // button flips to Stop.
    expect(screen.getByTestId("meeting-toggle").textContent).toContain("Stop meeting");
  });

  it("shows a live elapsed clock and the live transcript during recording", async () => {
    const { api, emitSegment } = makeFakeApi();
    const cap = makeFakeCaptureFactory();
    render(<MeetingControls api={api} createCaptureController={cap.factory} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });
    await waitFor(() => expect(screen.getByTestId("recording-elapsed")).toBeTruthy());
    expect(screen.getByTestId("live-transcript")).toBeTruthy();

    // A segment for the active meeting renders in the live view (the line also
    // carries its timestamp + speaker label in the editorial flow).
    emitSegment({ source: "mic", segId: "a", text: "hello there", status: "partial" });
    expect(screen.getByTestId("segment-mic-a").textContent).toContain("hello there");
  });

  it("mounts the in-call ChatPanel scoped to the active meeting while recording", async () => {
    // Regression guard for the dead-UI defect: ChatPanel must actually be on the
    // live render tree for an active meeting (not just built + unit-tested).
    const { api } = makeFakeApi();
    const cap = makeFakeCaptureFactory();
    render(<MeetingControls api={api} createCaptureController={cap.factory} />);

    // No active meeting yet -> no chat panel.
    expect(screen.queryByTestId("chat-panel")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("recording-status").getAttribute("data-phase")).toBe(
        "recording",
      ),
    );

    // The chat surface is now mounted for this meeting.
    const panel = await screen.findByTestId("chat-panel");
    expect(panel).toBeTruthy();
    // Composer is scoped to an active meeting (input enabled, not the
    // "open a meeting" placeholder).
    expect(screen.getByTestId("chat-input")).toHaveProperty("disabled", false);
  });

  it("Stop tears capture down and stops the meeting (→ processing)", async () => {
    const { api } = makeFakeApi();
    const cap = makeFakeCaptureFactory();
    render(<MeetingControls api={api} createCaptureController={cap.factory} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("meeting-toggle").textContent).toContain("Stop meeting"),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });

    expect(cap.stopAll).toHaveBeenCalled();
    expect(api.library.stopMeeting).toHaveBeenCalledWith({ id: ID });
    // The page STAYS put and becomes the finished document (no library round-trip);
    // while processing it shows the summary-centric doc with the summary streaming in.
    await waitFor(() =>
      expect(screen.getByTestId("meeting-controls").getAttribute("data-phase")).toBe(
        "processing",
      ),
    );
    expect(screen.getByTestId("meeting-view")).toBeTruthy();
  });

  it("transitions to done on a server status push and offers a new meeting", async () => {
    const { api, emitStatus } = makeFakeApi();
    const cap = makeFakeCaptureFactory();
    render(<MeetingControls api={api} createCaptureController={cap.factory} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });
    await waitFor(() => expect(screen.getByTestId("meeting-toggle")).toBeTruthy());

    emitStatus(meeting({ status: "done", endedAt: "2026-06-23T10:05:00.000Z", title: "Standup" }));
    await waitFor(() =>
      expect(screen.getByTestId("meeting-controls").getAttribute("data-phase")).toBe("done"),
    );
    // The finished meeting renders INLINE as the summary-centric document — the
    // same MeetingDoc used in the library — not a "go to your library" hero.
    expect(screen.getByTestId("meeting-view")).toBeTruthy();
    expect(screen.getByTestId("meeting-title").textContent).toContain("Standup");
    // A quiet "New meeting" affordance is offered (the page no longer dead-ends).
    expect(screen.getByTestId("meeting-new")).toBeTruthy();
  });

  it("surfaces a capture/permission error per-source while recording", async () => {
    const { api } = makeFakeApi();
    const cap = makeFakeCaptureFactory();
    render(<MeetingControls api={api} createCaptureController={cap.factory} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });
    await waitFor(() => expect(screen.getByTestId("meeting-meters")).toBeTruthy());

    cap.emit("system", { state: "error", level: 0, error: "screen recording denied" });
    await waitFor(() =>
      expect(screen.getByTestId("meeting-capture-error-system").textContent).toContain(
        "screen recording denied",
      ),
    );
  });

  it("surfaces a startMeeting failure as the error phase without throwing", async () => {
    const { api } = makeFakeApi({
      startMeeting: vi.fn(async () => {
        throw new Error("sidecar unreachable");
      }),
    });
    render(<MeetingControls api={api} createCaptureController={makeFakeCaptureFactory().factory} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("meeting-toggle"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("recording-status").getAttribute("data-phase")).toBe("error"),
    );
    expect(screen.getByTestId("recording-error").textContent).toContain("sidecar unreachable");
  });

  it("disables Start and explains when the sidecar is not connected", () => {
    const { api } = makeFakeApi();
    render(<MeetingControls api={api} sidecarStatus="disconnected" />);
    expect(screen.getByTestId("meeting-toggle")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("meeting-sidecar-note").textContent).toContain("disconnected");
  });
});
