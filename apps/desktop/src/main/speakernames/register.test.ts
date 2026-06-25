/**
 * Hermetic tests for the speaker-names IPC bridge + post-diarization hook (PRD-6).
 *
 * `electron` is mocked with a fake `ipcMain` that records `handle` registrations
 * so we invoke the bound handlers directly (no Electron runtime). The WS server,
 * store, correlate, and apply deps are fakes. Covers: status invoke delegates to
 * the server; status push reaches the live window; disposer removes the handler;
 * the correlation hook drains + correlates + applies and is a no-op on no
 * activity / not-diarized; the postProcessDone subscription gates to Google-Meet
 * meetings and anchors the engine clock to startedAt; every path is best-effort
 * (a thrown apply/correlate is swallowed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiarizedTranscript,
  Meeting,
  SpeakerCorrelationResult,
  SpeakerNamesStatus,
} from "@loqui/shared";
import type {
  BufferedMeetingActivity,
  SpeakerNamesCorrelationHookDeps,
} from "./types.js";

// --- Fake electron ipcMain ----------------------------------------------------
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

const {
  registerSpeakerNamesIpc,
  runSpeakerNamesCorrelation,
  subscribeSpeakerNamesCorrelation,
} = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");

beforeEach(() => {
  handlers.handle.clear();
  handlers.removedHandlers = [];
});
afterEach(() => vi.restoreAllMocks());

const STATUS: SpeakerNamesStatus = {
  state: "capturing",
  meetingActive: true,
  bufferedEvents: 3,
  lastEventAt: "2026-06-24T00:00:00.000Z",
  selectorVersion: "2026-06-24",
  extensionVersion: "1.0.0",
};

function makeWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  };
}

describe("registerSpeakerNamesIpc — status invoke + push", () => {
  it("status invoke delegates to the server", () => {
    const server = {
      getStatus: vi.fn(() => STATUS),
      onStatusChange: vi.fn(() => () => {}),
    };
    registerSpeakerNamesIpc({ server, getWindow: () => null });
    const result = handlers.handle.get(IPC.speakerNamesStatus)!(
      null,
    ) as SpeakerNamesStatus;
    expect(server.getStatus).toHaveBeenCalled();
    expect(result).toEqual(STATUS);
  });

  it("pushes status changes to the live window on IPC.speakerNamesStatusChanged", () => {
    let emit: ((s: SpeakerNamesStatus) => void) | null = null;
    const server = {
      getStatus: vi.fn(() => STATUS),
      onStatusChange: (cb: (s: SpeakerNamesStatus) => void) => {
        emit = cb;
        return () => {
          emit = null;
        };
      },
    };
    const win = makeWindow();
    registerSpeakerNamesIpc({ server, getWindow: () => win as never });
    emit!(STATUS);
    expect(win.sent).toHaveLength(1);
    expect(win.sent[0]!.channel).toBe(IPC.speakerNamesStatusChanged);
    expect(win.sent[0]!.payload).toEqual(STATUS);
  });

  it("does not throw when there is no live window", () => {
    let emit: ((s: SpeakerNamesStatus) => void) | null = null;
    const server = {
      getStatus: vi.fn(() => STATUS),
      onStatusChange: (cb: (s: SpeakerNamesStatus) => void) => {
        emit = cb;
        return () => {};
      },
    };
    registerSpeakerNamesIpc({ server, getWindow: () => null });
    expect(() => emit!(STATUS)).not.toThrow();
  });

  it("the disposer removes the handler and unsubscribes the push", () => {
    const unsub = vi.fn();
    const server = { getStatus: vi.fn(() => STATUS), onStatusChange: vi.fn(() => unsub) };
    const dispose = registerSpeakerNamesIpc({ server, getWindow: () => null });
    dispose();
    expect(unsub).toHaveBeenCalled();
    expect(handlers.removedHandlers).toContain(IPC.speakerNamesStatus);
  });
});

// --- correlation hook --------------------------------------------------------

const DIARIZED: DiarizedTranscript = {
  meetingId: "m1",
  version: 1,
  diarized: true,
  backend: "fake",
  speakers: ["Speaker 1"],
  segments: [
    {
      segId: "s1",
      source: "system",
      text: "hi",
      tStart: 0,
      tEnd: 5,
      speaker: "Speaker 1",
      displayName: null,
    },
  ],
};

function buffered(meetingId: string, n: number): BufferedMeetingActivity {
  return {
    meetingId,
    events: Array.from({ length: n }, (_, i) => ({
      ts: 1000 + i,
      name: "Alice",
      speaking: i % 2 === 0,
    })),
    participants: ["Alice"],
  };
}

const RESULT: SpeakerCorrelationResult = {
  meetingId: "m1",
  resolutions: [
    { speaker: "Speaker 1", name: "Alice", confidence: 0.9, support: 5000, apply: true },
  ],
  participants: ["Alice"],
  usedActivityEvents: 4,
  coveragePct: 1,
};

function makeHook(over: Partial<SpeakerNamesCorrelationHookDeps> = {}): {
  deps: SpeakerNamesCorrelationHookDeps;
  drain: ReturnType<typeof vi.fn>;
  correlate: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  diarized: DiarizedTranscript | null;
} {
  const drain = vi.fn((id: string) => buffered(id, 4));
  const correlate = vi.fn(() => RESULT);
  const apply = vi.fn(() => DIARIZED);
  const deps: SpeakerNamesCorrelationHookDeps = {
    server: { drainActivity: drain },
    store: {
      getMeeting: vi.fn(() => null),
      updateMeeting: vi.fn(),
      getSummary: vi.fn(() => null),
      getDiarizedTranscript: vi.fn(() => DIARIZED),
      upsertSearchText: vi.fn(),
    } as never,
    correlate: correlate as never,
    apply: apply as never,
    ...over,
  };
  return { deps, drain, correlate, apply, diarized: DIARIZED };
}

describe("runSpeakerNamesCorrelation — the post-diarization hook", () => {
  it("drains, correlates over the diarized transcript, and applies the result", () => {
    const { deps, drain, correlate, apply } = makeHook();
    const out = runSpeakerNamesCorrelation(deps, "m1");
    expect(drain).toHaveBeenCalledWith("m1");
    expect(correlate).toHaveBeenCalled();
    // correlate gets the diarized transcript + the buffered events.
    expect((correlate.mock.calls[0] as unknown[])[0]).toEqual(DIARIZED);
    expect(apply).toHaveBeenCalledWith(deps.store, RESULT);
    expect(out).toEqual(RESULT);
  });

  it("is a no-op (returns null) when no activity was captured", () => {
    const drain = vi.fn(() => ({ meetingId: "m1", events: [], participants: [] }));
    const { deps, correlate, apply } = makeHook({ server: { drainActivity: drain } });
    expect(runSpeakerNamesCorrelation(deps, "m1")).toBeNull();
    expect(correlate).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("is a no-op when the meeting is not diarized", () => {
    const { deps, correlate } = makeHook();
    (deps.store.getDiarizedTranscript as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(runSpeakerNamesCorrelation(deps, "m1")).toBeNull();
    expect(correlate).not.toHaveBeenCalled();
  });

  it("swallows a correlate/apply error and returns null (graceful degradation)", () => {
    const apply = vi.fn(() => {
      throw new Error("boom");
    });
    const { deps } = makeHook({ apply: apply as never });
    expect(() => runSpeakerNamesCorrelation(deps, "m1")).not.toThrow();
    expect(runSpeakerNamesCorrelation(deps, "m1")).toBeNull();
  });
});

// --- subscribeSpeakerNamesCorrelation (postProcessDone gating) ---------------

function meeting(id: string, patch: Partial<Meeting> = {}): Meeting {
  const now = "2026-06-24T00:00:00.000Z";
  return {
    id,
    title: "",
    platform: "google-meet",
    startedAt: now,
    endedAt: now,
    status: "done",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

function makeSupervisor() {
  let cb: ((event: string, data: unknown) => void) | null = null;
  return {
    emit: (event: string, data: unknown) => cb?.(event, data),
    onNotification(fn: (event: string, data: unknown) => void): () => void {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  };
}

describe("subscribeSpeakerNamesCorrelation — postProcessDone gating", () => {
  it("runs correlation for a Google-Meet meeting on postProcessDone, anchored to startedAt", () => {
    const { deps, drain } = makeHook();
    const supervisor = makeSupervisor();
    const startedAt = "2026-06-24T01:00:00.000Z";
    subscribeSpeakerNamesCorrelation({
      supervisor,
      hook: deps,
      getMeeting: (id) =>
        id === "m1" ? meeting("m1", { platform: "google-meet", startedAt }) : null,
    });
    supervisor.emit("postProcessDone", { meetingId: "m1", speakers: [], indexText: "" });
    expect(drain).toHaveBeenCalledWith("m1");
    // The engine clock was anchored to the meeting's startedAt epoch ms.
    expect((deps.correlate as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({
      meetingStartEpochMs: Date.parse(startedAt),
    });
  });

  it("does NOT run correlation for a non-Google-Meet meeting (keeps generic labels)", () => {
    const { deps, drain } = makeHook();
    const supervisor = makeSupervisor();
    subscribeSpeakerNamesCorrelation({
      supervisor,
      hook: deps,
      getMeeting: () => meeting("m1", { platform: "zoom" }),
    });
    supervisor.emit("postProcessDone", { meetingId: "m1", speakers: [], indexText: "" });
    expect(drain).not.toHaveBeenCalled();
  });

  it("ignores non-postProcessDone events and malformed payloads", () => {
    const { deps, drain } = makeHook();
    const supervisor = makeSupervisor();
    subscribeSpeakerNamesCorrelation({
      supervisor,
      hook: deps,
      getMeeting: () => meeting("m1"),
    });
    supervisor.emit("jobUpdate", { jobId: "j1" });
    supervisor.emit("postProcessDone", "garbage");
    expect(drain).not.toHaveBeenCalled();
  });

  it("unsubscribe stops the subscription", () => {
    const { deps, drain } = makeHook();
    const supervisor = makeSupervisor();
    const off = subscribeSpeakerNamesCorrelation({
      supervisor,
      hook: deps,
      getMeeting: () => meeting("m1"),
    });
    off();
    supervisor.emit("postProcessDone", { meetingId: "m1", speakers: [], indexText: "" });
    expect(drain).not.toHaveBeenCalled();
  });
});
