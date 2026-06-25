/**
 * Hermetic tests for the main-process post-processing pipeline (PRD-5).
 *
 * Fakes: a supervisor (records `postProcess` notifications + lets a test emit
 * `audioFinalized`/`postProcessDone`), a store (in-memory meetings + index +
 * meta), a provider-key source, and an HF keystore. No electron, no WS, no
 * network, no keychain, no torch/HF.
 *
 * Invariants asserted:
 *   - stop -> (audioFinalized) -> ONE `postProcess` request with the right payload
 *     (provider config + transient summary key + transient HF token);
 *   - missing HF token -> diarization requested as degraded (hfToken null), and
 *     the summary still runs (request is still sent);
 *   - postProcessDone -> index updated + participants set + status "done";
 *   - a degraded/skipped diarization STILL completes the meeting to "done";
 *   - the regenerate path dispatches a summary-only request without waiting;
 *   - the pipeline never writes the live transcript (structural).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiarizationBackendPreference, Meeting, ProviderConfig } from "@loqui/shared";
import { createPostProcessPipeline } from "./pipeline.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loqui-pp-"));
  process.env.LOQUI_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.LOQUI_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// --- Fakes -------------------------------------------------------------------

function makeSupervisor() {
  const sent: Array<{ event: string; data: unknown }> = [];
  let cb: ((event: string, data: unknown) => void) | null = null;
  return {
    sent,
    emit(event: string, data: unknown) {
      cb?.(event, data);
    },
    sendControlNotification(event: string, data: unknown): boolean {
      sent.push({ event, data });
      return true;
    },
    onNotification(fn: (event: string, data: unknown) => void): () => void {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  };
}

function meeting(id: string, patch: Partial<Meeting> = {}): Meeting {
  const now = "2026-06-23T00:00:00.000Z";
  return {
    id,
    title: "",
    platform: null,
    startedAt: now,
    endedAt: now,
    status: "processing",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

function makeStore(initial: Meeting[] = []) {
  const meetings = new Map<string, Meeting>();
  for (const m of initial) meetings.set(m.id, m);
  const indexed: Array<{ meetingId: string; summary?: string }> = [];
  return {
    indexed,
    meetings,
    getMeeting(id: string): Meeting | null {
      return meetings.get(id) ?? null;
    },
    updateMeeting(id: string, patch: Partial<Meeting>): Meeting {
      const current = meetings.get(id);
      if (!current) throw new Error(`unknown meeting ${id}`);
      const updated = { ...current, ...patch, id, updatedAt: "2026-06-23T00:00:01.000Z" };
      meetings.set(id, updated);
      return updated;
    },
    upsertSearchText(text: { meetingId: string; summary?: string }): void {
      indexed.push(text);
    },
  };
}

const config: ProviderConfig = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  baseUrl: "http://localhost:11434",
  ollamaModel: "llama3.1",
  cli: "claude",
};

function makeProviderKeys(opts: { provider?: ProviderConfig["provider"]; apiKey?: string | null } = {}) {
  const calls: string[] = [];
  return {
    calls,
    getProviderSettings(): ProviderConfig {
      return { ...config, provider: opts.provider ?? "anthropic" };
    },
    getApiKey(provider: "anthropic"): string | null {
      calls.push(provider);
      return opts.apiKey ?? "sk-ant-SUMMARY";
    },
  };
}

function makeHfKeystore(
  token: string | null,
  diarizationBackend: DiarizationBackendPreference = "auto",
) {
  return {
    getHfToken: () => token,
    getDiarizationBackend: () => diarizationBackend,
  };
}

// --- Tests -------------------------------------------------------------------

describe("pipeline — stop -> audioFinalized -> postProcess request", () => {
  it("sends ONE postProcess request after audioFinalized with the right payload", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys({ apiKey: "sk-ant-SUMMARY" }),
      hfKeystore: makeHfKeystore("hf_TOKEN"),
    });

    // The controller hook fires on stop.
    pipeline.onMeetingProcessing(meeting("m1"));
    // No request yet — we wait for the WAVs to finalize.
    expect(supervisor.sent).toHaveLength(0);

    // audioFinalized arrives -> dispatch.
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });

    expect(supervisor.sent).toHaveLength(1);
    const { event, data } = supervisor.sent[0]!;
    expect(event).toBe("postProcess");
    expect(data).toMatchObject({
      meetingId: "m1",
      apiKey: "sk-ant-SUMMARY",
      hfToken: "hf_TOKEN",
      diarizationBackend: "auto",
      regenerateSummary: false,
      rediarize: false,
    });
    expect((data as { providerConfig: { provider: string } }).providerConfig.provider).toBe("anthropic");

    // A second audioFinalized (e.g. the mic stream) does NOT re-dispatch.
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "mic" });
    expect(supervisor.sent).toHaveLength(1);
    pipeline.dispose();
  });

  it("forwards a null apiKey for a local summary provider (no keychain read)", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const providerKeys = makeProviderKeys({ provider: "fake" });
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys,
      hfKeystore: makeHfKeystore("hf_TOKEN"),
    });
    pipeline.onMeetingProcessing(meeting("m1"));
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });
    expect((supervisor.sent[0]!.data as { apiKey: unknown }).apiKey).toBeNull();
    expect(providerKeys.calls).toEqual([]); // never decrypts a key for a non-anthropic provider
    pipeline.dispose();
  });

  it("missing HF token -> hfToken null in the request (diarization degrades), summary still runs", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore(null), // no HF token
    });
    pipeline.onMeetingProcessing(meeting("m1"));
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });

    // The request is STILL sent (the summary step runs even with no HF token);
    // hfToken is null; the default auto backend will choose local sherpa.
    expect(supervisor.sent).toHaveLength(1);
    expect((supervisor.sent[0]!.data as { hfToken: unknown }).hfToken).toBeNull();
    expect((supervisor.sent[0]!.data as { diarizationBackend: unknown }).diarizationBackend).toBe(
      "auto",
    );
    expect((supervisor.sent[0]!.data as { apiKey: unknown }).apiKey).toBe("sk-ant-SUMMARY");
    pipeline.dispose();
  });

  it("threads an explicit diarizationBackend preference into the request", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf_TOKEN", "sherpa"),
    });
    pipeline.onMeetingProcessing(meeting("m1"));
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });

    expect((supervisor.sent[0]!.data as { diarizationBackend: unknown }).diarizationBackend).toBe(
      "sherpa",
    );
    pipeline.dispose();
  });

  it("ignores audioFinalized for a meeting that is not awaiting post-processing", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf"),
    });
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });
    expect(supervisor.sent).toHaveLength(0);
    pipeline.dispose();
  });
});

describe("pipeline — postProcessDone finalizes the meeting", () => {
  it("indexes the diarized+summary text, sets participants/modelVersions, status done", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const emitted: Meeting[] = [];
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf"),
      emitStatus: (m) => emitted.push(m),
    });

    supervisor.emit("postProcessDone", {
      meetingId: "m1",
      diarization: "done",
      summary: "done",
      speakers: ["Speaker 1", "Speaker 2"],
      diarizationBackend: "pyannote/speaker-diarization-3.1",
      summaryProvider: "anthropic",
      summaryModel: "claude-opus-4-8",
      indexText: "You: hello Speaker 1: hi We shipped it",
      note: "",
    });

    const finalized = store.getMeeting("m1")!;
    expect(finalized.status).toBe("done");
    // Speakers folded into meta.participants (label -> label until PRD-6).
    expect(finalized.participants.map((p) => p.speakerLabel)).toEqual(["Speaker 1", "Speaker 2"]);
    expect(finalized.participants.map((p) => p.name)).toEqual(["Speaker 1", "Speaker 2"]);
    // Backends recorded into modelVersions.
    expect(finalized.modelVersions.diarization).toBe("pyannote/speaker-diarization-3.1");
    expect(finalized.modelVersions.summary).toBe("anthropic/claude-opus-4-8");
    // Index updated with the searchable text (summary column).
    expect(store.indexed).toEqual([{ meetingId: "m1", summary: "You: hello Speaker 1: hi We shipped it" }]);
    // Status push emitted with the done meeting.
    expect(emitted.at(-1)?.status).toBe("done");
    pipeline.dispose();
  });

  it("STILL completes to done when diarization was skipped (degraded)", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore(null),
    });

    supervisor.emit("postProcessDone", {
      meetingId: "m1",
      diarization: "skipped",
      summary: "done",
      speakers: [],
      diarizationBackend: "",
      summaryProvider: "fake",
      summaryModel: "scripted",
      indexText: "summary text only",
      note: "no HF token; diarization skipped",
    });

    const finalized = store.getMeeting("m1")!;
    expect(finalized.status).toBe("done");
    // No diarization backend recorded (it was skipped).
    expect(finalized.modelVersions.diarization).toBeUndefined();
    expect(finalized.modelVersions.summary).toBe("fake/scripted");
    pipeline.dispose();
  });

  it("does not duplicate participants on a re-diarize (merge by speakerLabel)", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([
      meeting("m1", {
        participants: [{ id: "Speaker 1", name: "Alex", speakerLabel: "Speaker 1" }],
        status: "done",
      }),
    ]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf"),
    });

    supervisor.emit("postProcessDone", {
      meetingId: "m1",
      diarization: "done",
      summary: "done",
      speakers: ["Speaker 1", "Speaker 2"],
      diarizationBackend: "fake",
      summaryProvider: "fake",
      summaryModel: "",
      indexText: "x",
      note: "",
    });

    const finalized = store.getMeeting("m1")!;
    // Speaker 1 kept its rename (Alex); Speaker 2 added once.
    expect(finalized.participants).toHaveLength(2);
    expect(finalized.participants.find((p) => p.speakerLabel === "Speaker 1")?.name).toBe("Alex");
    expect(finalized.participants.find((p) => p.speakerLabel === "Speaker 2")?.name).toBe("Speaker 2");
    pipeline.dispose();
  });

  it("flips the meeting to error if the store update throws (never stuck in processing)", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1")]);
    let firstUpdate = true;
    const origUpdate = store.updateMeeting.bind(store);
    store.updateMeeting = (id: string, patch: Partial<Meeting>) => {
      if (firstUpdate && patch.status === "done") {
        firstUpdate = false;
        throw new Error("disk full");
      }
      return origUpdate(id, patch);
    };
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf"),
    });

    supervisor.emit("postProcessDone", {
      meetingId: "m1",
      diarization: "done",
      summary: "done",
      speakers: [],
      diarizationBackend: "fake",
      summaryProvider: "fake",
      summaryModel: "",
      indexText: "",
      note: "",
    });

    expect(store.getMeeting("m1")!.status).toBe("error");
    pipeline.dispose();
  });

  it("ignores postProcessDone for an unknown meeting", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf"),
    });
    expect(() =>
      supervisor.emit("postProcessDone", {
        meetingId: "ghost",
        diarization: "done",
        summary: "done",
        speakers: [],
        diarizationBackend: "",
        summaryProvider: "",
        summaryModel: "",
        indexText: "x",
        note: "",
      }),
    ).not.toThrow();
    expect(store.indexed).toHaveLength(0);
    pipeline.dispose();
  });
});

describe("pipeline — regenerate summary", () => {
  it("dispatches a summary-only request immediately (no audioFinalized wait)", () => {
    const supervisor = makeSupervisor();
    const store = makeStore([meeting("m1", { status: "done" })]);
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: makeProviderKeys(),
      hfKeystore: makeHfKeystore("hf"),
    });

    const ok = pipeline.requestSummaryRegeneration("m1");
    expect(ok).toBe(true);
    expect(supervisor.sent).toHaveLength(1);
    expect(supervisor.sent[0]!.event).toBe("postProcess");
    expect(supervisor.sent[0]!.data).toMatchObject({
      meetingId: "m1",
      regenerateSummary: true,
      rediarize: false,
    });
    pipeline.dispose();
  });
});

describe("pipeline — structural: no live-transcript write capability", () => {
  it("the pipeline CODE (comments stripped) imports no TranscriptWriter / writer path", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const code = stripComments(fs.readFileSync(path.join(__dirname, "pipeline.ts"), "utf8"));
    expect(code).not.toMatch(/TranscriptWriter|transcript\/writer|appendTranscriptSegment/);
    expect(code).not.toMatch(/transcript\.live|transcript\.jsonl/);
    // The pipeline itself performs NO fs writes — it persists only via the store.
    expect(code).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/);
  });
});

/** Strip block + line comments so structural assertions test CODE, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
