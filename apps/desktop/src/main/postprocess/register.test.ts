/**
 * Hermetic tests for the main-process post-processing IPC + WS bridge (PRD-5).
 *
 * `electron` is mocked with a fake `ipcMain` that records `handle` registrations
 * so we can invoke the bound handlers directly (no Electron runtime). The store,
 * HF keystore, and pipeline are fakes; the rename rewrite path uses a temp
 * LOQUI_DATA_DIR so the real diarized-file writer runs hermetically.
 *
 * Invariants asserted:
 *   - getSummary / getDiarizedTranscript delegate to the (READ-ONLY) store reader;
 *   - renameSpeaker rewrites the diarized files (json + re-rendered md), persists
 *     the rename into meta.participants, re-indexes, and returns the updated
 *     diarized transcript — without touching the live transcript;
 *   - regenerateSummary delegates to the pipeline;
 *   - setHfToken / getHfTokenStatus delegate to the keystore and never echo the token;
 *   - the jobUpdate WS notifications are relayed to the renderer (malformed dropped);
 *   - the bridge has NO live-transcript-write capability (structural).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiarizedTranscript, Meeting, Summary } from "@loqui/shared";

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

const { registerPostProcessIpc, forwardJobUpdates } = await import("./register.js");
const { IPC } = await import("../../shared/ipc.js");
const { meetingDiarizedTranscriptJsonPath, meetingDiarizedTranscriptMdPath, meetingLiveTranscriptPath } =
  await import("../store/paths.js");
const { writeDiarizedTranscript } = await import("./writers.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loqui-ppreg-"));
  process.env.LOQUI_DATA_DIR = dir;
  handlers.handle.clear();
  handlers.removedHandlers = [];
});
afterEach(() => {
  delete process.env.LOQUI_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- Fakes -------------------------------------------------------------------

function meeting(id: string, patch: Partial<Meeting> = {}): Meeting {
  const now = "2026-06-23T00:00:00.000Z";
  return {
    id,
    title: "",
    platform: null,
    startedAt: now,
    endedAt: now,
    status: "done",
    participants: [],
    modelVersions: {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

function makeStore(opts: {
  meetings?: Meeting[];
  summary?: Summary | null;
  diarized?: DiarizedTranscript | null;
} = {}) {
  const meetings = new Map<string, Meeting>();
  for (const m of opts.meetings ?? []) meetings.set(m.id, m);
  const indexed: Array<{ meetingId: string; summary?: string }> = [];
  return {
    indexed,
    meetings,
    getMeeting: (id: string): Meeting | null => meetings.get(id) ?? null,
    updateMeeting: (id: string, patch: Partial<Meeting>): Meeting => {
      const cur = meetings.get(id);
      if (!cur) throw new Error(`unknown ${id}`);
      const next = { ...cur, ...patch, id, updatedAt: "2026-06-23T00:00:02.000Z" };
      meetings.set(id, next);
      return next;
    },
    getSummary: (_id: string): Summary | null => opts.summary ?? null,
    getDiarizedTranscript: (_id: string): DiarizedTranscript | null => opts.diarized ?? null,
    upsertSearchText: (text: { meetingId: string; summary?: string }): void => {
      indexed.push(text);
    },
  };
}

function makeHfKeystore() {
  const setCalls: unknown[] = [];
  const backendCalls: unknown[] = [];
  return {
    setCalls,
    backendCalls,
    setHfToken(params: { token: string | null }) {
      setCalls.push(params);
      return { hasToken: Boolean(params.token && params.token.trim()) };
    },
    getHfTokenStatus() {
      return { hasToken: true };
    },
    setDiarizationBackend(params: { diarizationBackend: "auto" | "sherpa" | "pyannote" }) {
      backendCalls.push(params);
      return { diarizationBackend: params.diarizationBackend };
    },
    getDiarizationBackendStatus() {
      return { diarizationBackend: "auto" as const };
    },
  };
}

function makePipeline() {
  const regenCalls: string[] = [];
  return {
    regenCalls,
    requestSummaryRegeneration(id: string): boolean {
      regenCalls.push(id);
      return true;
    },
  };
}

const baseDiarized = (id: string): DiarizedTranscript => ({
  meetingId: id,
  version: 1,
  diarized: true,
  backend: "fake",
  speakers: ["Speaker 1", "Speaker 2"],
  segments: [
    { segId: "s1", source: "mic", text: "Hello", tStart: 0, tEnd: 1, speaker: "You", displayName: null },
    { segId: "s2", source: "system", text: "Hi there", tStart: 5, tEnd: 7, speaker: "Speaker 1", displayName: null },
    { segId: "s3", source: "system", text: "Bye", tStart: 9, tEnd: 10, speaker: "Speaker 2", displayName: null },
  ],
});

// --- Read handlers -----------------------------------------------------------

describe("registerPostProcessIpc — read handlers", () => {
  it("getSummary delegates to the store reader", () => {
    const summary = { meetingId: "m1", version: 1, tldr: "x", decisions: [], actionItems: [], topics: [], provider: "fake", model: "", generatedAt: "" } as Summary;
    const store = makeStore({ summary });
    registerPostProcessIpc({ store, hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    const h = handlers.handle.get(IPC.getSummary)!;
    expect(h(null, { meetingId: "m1" })).toEqual(summary);
  });

  it("getDiarizedTranscript delegates to the store reader", () => {
    const diarized = baseDiarized("m1");
    const store = makeStore({ diarized });
    registerPostProcessIpc({ store, hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    const h = handlers.handle.get(IPC.getDiarizedTranscript)!;
    expect(h(null, { meetingId: "m1" })).toEqual(diarized);
  });

  it("getSummary returns null when absent", () => {
    const store = makeStore({ summary: null });
    registerPostProcessIpc({ store, hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    expect(handlers.handle.get(IPC.getSummary)!(null, { meetingId: "m1" })).toBeNull();
  });
});

// --- renameSpeaker -----------------------------------------------------------

describe("registerPostProcessIpc — renameSpeaker", () => {
  it("rewrites the diarized files, persists meta.participants, re-indexes, returns updated transcript", () => {
    const diarized = baseDiarized("m1");
    // The reader must reflect the actual on-disk diarized JSON. Write it first so
    // a re-render is exercised against a real file, and the store fake returns it.
    writeDiarizedTranscript(diarized);
    const store = makeStore({
      meetings: [meeting("m1", { participants: [{ id: "Speaker 1", name: "Speaker 1", speakerLabel: "Speaker 1" }] })],
      diarized,
      summary: null,
    });
    registerPostProcessIpc({ store, hfKeystore: makeHfKeystore(), pipeline: makePipeline() });

    const h = handlers.handle.get(IPC.renameSpeaker)!;
    const result = h(null, { meetingId: "m1", speaker: "Speaker 1", displayName: "Alex" }) as DiarizedTranscript;

    // Returned transcript carries the displayName on the matching segments only.
    expect(result.segments.find((s) => s.segId === "s2")?.displayName).toBe("Alex");
    expect(result.segments.find((s) => s.segId === "s3")?.displayName).toBeNull();

    // The diarized .md was re-rendered with the friendly name.
    const md = readFileSync(meetingDiarizedTranscriptMdPath("m1"), "utf8");
    expect(md).toContain("Alex: Hi there");
    expect(md).not.toContain("Speaker 1: Hi there");
    // The diarized .json persists the displayName.
    const jsonOnDisk = JSON.parse(readFileSync(meetingDiarizedTranscriptJsonPath("m1"), "utf8")) as DiarizedTranscript;
    expect(jsonOnDisk.segments.find((s) => s.segId === "s2")?.displayName).toBe("Alex");

    // meta.participants updated with the rename.
    expect(store.getMeeting("m1")!.participants.find((p) => p.speakerLabel === "Speaker 1")?.name).toBe("Alex");

    // Re-indexed (summary column) with the friendly name in the searchable text.
    expect(store.indexed).toHaveLength(1);
    expect(store.indexed[0]!.summary).toContain("Alex: Hi there");

    // The LIVE transcript was never created/touched by the rename.
    expect(existsSync(meetingLiveTranscriptPath("m1"))).toBe(false);
  });

  it("clears the rename back to the label on an empty displayName", () => {
    const diarized = {
      ...baseDiarized("m2"),
      segments: baseDiarized("m2").segments.map((s) =>
        s.speaker === "Speaker 1" ? { ...s, displayName: "Alex" } : s,
      ),
    };
    writeDiarizedTranscript(diarized);
    const store = makeStore({
      meetings: [meeting("m2", { participants: [{ id: "Speaker 1", name: "Alex", speakerLabel: "Speaker 1" }] })],
      diarized,
    });
    registerPostProcessIpc({ store, hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    const h = handlers.handle.get(IPC.renameSpeaker)!;
    const result = h(null, { meetingId: "m2", speaker: "Speaker 1", displayName: "" }) as DiarizedTranscript;
    expect(result.segments.find((s) => s.segId === "s2")?.displayName).toBeNull();
    expect(store.getMeeting("m2")!.participants.find((p) => p.speakerLabel === "Speaker 1")?.name).toBe("Speaker 1");
  });

  it("throws when the meeting is not diarized", () => {
    const store = makeStore({ diarized: null, meetings: [meeting("m3")] });
    registerPostProcessIpc({ store, hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    const h = handlers.handle.get(IPC.renameSpeaker)!;
    expect(() => h(null, { meetingId: "m3", speaker: "Speaker 1", displayName: "Alex" })).toThrow(/not diarized/);
  });
});

// --- regenerate + HF token ---------------------------------------------------

describe("registerPostProcessIpc — regenerate + HF token", () => {
  it("regenerateSummary delegates to the pipeline", () => {
    const pipeline = makePipeline();
    registerPostProcessIpc({ store: makeStore(), hfKeystore: makeHfKeystore(), pipeline });
    handlers.handle.get(IPC.regenerateSummary)!(null, { meetingId: "m1" });
    expect(pipeline.regenCalls).toEqual(["m1"]);
  });

  it("setHfToken delegates and returns only {hasToken} — never the token", () => {
    const hfKeystore = makeHfKeystore();
    registerPostProcessIpc({ store: makeStore(), hfKeystore, pipeline: makePipeline() });
    const result = handlers.handle.get(IPC.setHfToken)!(null, { token: "hf_SECRET" }) as Record<string, unknown>;
    expect(result).toEqual({ hasToken: true });
    expect(JSON.stringify(result)).not.toContain("hf_SECRET");
    expect(hfKeystore.setCalls).toHaveLength(1);
  });

  it("getHfTokenStatus delegates to the keystore", () => {
    registerPostProcessIpc({ store: makeStore(), hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    expect(handlers.handle.get(IPC.getHfTokenStatus)!(null)).toEqual({ hasToken: true });
  });

  it("set/getDiarizationBackend delegates to the keystore", () => {
    const hfKeystore = makeHfKeystore();
    registerPostProcessIpc({ store: makeStore(), hfKeystore, pipeline: makePipeline() });
    expect(
      handlers.handle.get(IPC.setDiarizationBackend)!(null, {
        diarizationBackend: "pyannote",
      }),
    ).toEqual({ diarizationBackend: "pyannote" });
    expect(hfKeystore.backendCalls).toEqual([{ diarizationBackend: "pyannote" }]);
    expect(handlers.handle.get(IPC.getDiarizationBackendStatus)!(null)).toEqual({
      diarizationBackend: "auto",
    });
  });

  it("the disposer removes every handler it registered", () => {
    const dispose = registerPostProcessIpc({ store: makeStore(), hfKeystore: makeHfKeystore(), pipeline: makePipeline() });
    dispose();
    expect(handlers.removedHandlers).toEqual(
      expect.arrayContaining([
        IPC.getSummary,
        IPC.getDiarizedTranscript,
        IPC.renameSpeaker,
        IPC.regenerateSummary,
        IPC.setHfToken,
        IPC.getHfTokenStatus,
        IPC.setDiarizationBackend,
        IPC.getDiarizationBackendStatus,
      ]),
    );
  });
});

// --- forwardJobUpdates -------------------------------------------------------

describe("forwardJobUpdates — relaying job progress to the renderer", () => {
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
  function makeWindow() {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    return {
      sent,
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
  }

  it("relays a valid diarization/summary jobUpdate to the renderer", () => {
    const supervisor = makeSupervisor();
    const win = makeWindow();
    forwardJobUpdates(supervisor, () => win as never);
    supervisor.emit("jobUpdate", { jobId: "j1", kind: "diarization", state: "running", progress: 0.5 });
    supervisor.emit("jobUpdate", { jobId: "j2", kind: "summary", state: "done", progress: 1 });
    expect(win.sent.map((s) => s.channel)).toEqual([IPC.postProcessJob, IPC.postProcessJob]);
    expect(win.sent[0]!.payload).toMatchObject({ jobId: "j1", kind: "diarization", state: "running" });
  });

  it("ignores non-jobUpdate notifications and malformed payloads", () => {
    const supervisor = makeSupervisor();
    const win = makeWindow();
    forwardJobUpdates(supervisor, () => win as never);
    supervisor.emit("transcriptSegment", { segId: "s1" }); // not a jobUpdate
    supervisor.emit("jobUpdate", { kind: "diarization" }); // missing jobId (min 1)
    supervisor.emit("jobUpdate", "garbage");
    expect(win.sent).toHaveLength(0);
  });

  it("does not throw when there is no live window and stops on unsubscribe", () => {
    const supervisor = makeSupervisor();
    const off = forwardJobUpdates(supervisor, () => null);
    expect(() => supervisor.emit("jobUpdate", { jobId: "j", kind: "summary", state: "done", progress: 1 })).not.toThrow();
    const win = makeWindow();
    off();
    forwardJobUpdates(supervisor, () => win as never)();
    supervisor.emit("jobUpdate", { jobId: "j", kind: "summary", state: "done", progress: 1 });
    expect(win.sent).toHaveLength(0);
  });
});

// --- structural --------------------------------------------------------------

describe("structural: no live-transcript-write capability in the postprocess module", () => {
  it("register/writers/render/hf-keystore CODE imports no TranscriptWriter and writes no live transcript", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["register.ts", "writers.ts", "render.ts", "hf-keystore.ts", "pipeline.ts", "index.ts"]) {
      const code = stripComments(fs.readFileSync(path.join(__dirname, file), "utf8"));
      expect(code, file).not.toMatch(/TranscriptWriter|transcript\/writer|appendTranscriptSegment|consumeFinalTranscriptSegments/);
      // No module here targets the live transcript / structured jsonl / meta file.
      expect(code, file).not.toMatch(/meetingLiveTranscriptPath|meetingTranscriptPath|meetingMetaPath|writeMeta/);
      expect(code, file).not.toMatch(/transcript\.live|transcript\.jsonl/);
    }
  });

  it("writers.ts CODE writes ONLY the diarized derived files (never the live transcript / summary / meta)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const code = stripComments(fs.readFileSync(path.join(__dirname, "writers.ts"), "utf8"));
    // The only meeting paths it constructs are the two diarized derived files.
    expect(code).toMatch(/meetingDiarizedTranscriptJsonPath/);
    expect(code).toMatch(/meetingDiarizedTranscriptMdPath/);
    expect(code).not.toMatch(/meetingSummaryPath|meetingLiveTranscriptPath|meetingMetaPath/);
    // No raw meetings/<id> path string.
    expect(code).not.toMatch(/["'][^"']*meetings[^"']*["']/);
  });
});

/** Strip block + line comments so structural assertions test CODE, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
