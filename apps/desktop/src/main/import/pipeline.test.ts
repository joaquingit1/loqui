/**
 * Hermetic tests for the file-import pipeline (PRD-12, main side).
 *
 * Uses the REAL meeting store (temp LOQUI_DATA_DIR) + a fake supervisor so we
 * exercise the actual create-meeting + finalize + FTS-index path without a
 * sidecar. Proves: an import mints a `kind:"import"` meeting, sends the
 * `importFile` WS request, and on `importFileDone` indexes the searchable text +
 * transitions the meeting to "done" (and to "error" when the file can't decode),
 * uniformly with a normal meeting (so library + search include it).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV, IMPORT_FILE_DONE_EVENT, IMPORT_FILE_EVENT } from "@loqui/shared";
import type { ProviderConfig } from "@loqui/shared";
import { openStore, type MeetingStore } from "../store/index.js";
import { createImportPipeline, type ImportPipeline } from "./pipeline.js";

let tmp: string;
let store: MeetingStore;

/** A fake supervisor that records sent notifications + lets tests fire pushes. */
function makeSupervisor() {
  const sent: Array<{ event: string; data: unknown }> = [];
  let cb: ((event: string, data: unknown) => void) | null = null;
  return {
    sent,
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
    emit(event: string, data: unknown): void {
      cb?.(event, data);
    },
  };
}

const providerKeys = {
  getProviderSettings: (): ProviderConfig => ({
    provider: "fake",
    model: "m",
    baseUrl: "http://localhost:11434",
    ollamaModel: "llama3.1",
    cli: "claude",
    nativeModel: "mlx:small",
    summaryTemplate: "Custom summary:\n{transcript}",
  }),
  getApiKey: (_provider: "anthropic"): string | null => null,
};
const hfKeystore = {
  getHfToken: (): string | null => null,
  getDiarizationBackend: () => "auto" as const,
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-import-"));
  process.env[DATA_DIR_ENV] = tmp;
  store = openStore();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* noop */
  }
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("createImportPipeline", () => {
  let pipeline: ImportPipeline;
  let supervisor: ReturnType<typeof makeSupervisor>;
  const statuses: string[] = [];

  beforeEach(() => {
    supervisor = makeSupervisor();
    statuses.length = 0;
    pipeline = createImportPipeline({
      supervisor,
      store,
      providerKeys,
      hfKeystore,
      emitStatus: (m) => statuses.push(`${m.id}:${m.status}`),
      now: () => "2026-06-24T12:00:00.000Z",
    });
  });

  afterEach(() => pipeline.dispose());

  it("mints a kind:'import' processing meeting and sends importFile", () => {
    const meeting = pipeline.importFile({ filePath: "/clips/standup.m4a" });

    expect(meeting.kind).toBe("import");
    expect(meeting.status).toBe("processing");
    // Title defaults to the file base name when none is given.
    expect(meeting.title).toBe("standup.m4a");

    // The meeting is persisted + appears in the library immediately.
    expect(store.getMeeting(meeting.id)?.kind).toBe("import");
    expect(store.listMeetings().map((m) => m.id)).toContain(meeting.id);

    // One importFile WS request carrying the meeting id + absolute path.
    expect(supervisor.sent).toHaveLength(1);
    const req = supervisor.sent[0];
    expect(req?.event).toBe(IMPORT_FILE_EVENT);
    expect(req?.data).toMatchObject({
      meetingId: meeting.id,
      filePath: "/clips/standup.m4a",
      providerConfig: {
        nativeModel: "mlx:small",
        summaryTemplate: "Custom summary:\n{transcript}",
      },
    });
  });

  it("uses an explicit title when provided", () => {
    const meeting = pipeline.importFile({ filePath: "/a/b.mp3", title: "Q3 retro" });
    expect(meeting.title).toBe("Q3 retro");
  });

  it("finalizes to done + indexes searchable text on importFileDone", () => {
    const meeting = pipeline.importFile({ filePath: "/c/talk.wav" });

    supervisor.emit(IMPORT_FILE_DONE_EVENT, {
      meetingId: meeting.id,
      ok: true,
      transcription: "done",
      diarization: "done",
      summary: "done",
      speakers: ["Speaker 1", "Speaker 2"],
      diarizationBackend: "fake",
      summaryProvider: "fake",
      summaryModel: "fake",
      indexText: "discussed the aurora launch timeline",
      note: "",
    });

    const finalized = store.getMeeting(meeting.id);
    expect(finalized).not.toBeNull();
    expect(finalized?.status).toBe("done");
    expect(finalized?.participants.map((p) => p.speakerLabel)).toEqual([
      "Speaker 1",
      "Speaker 2",
    ]);
    expect(finalized?.modelVersions.diarization).toBe("fake");
    expect(statuses).toContain(`${meeting.id}:done`);

    // The indexed text is full-text searchable (uniform with a normal meeting).
    const hits = store.searchMeetings("aurora");
    expect(hits.map((h) => h.meeting.id)).toContain(meeting.id);
  });

  it("finalizes to error when the file could not be decoded (ok:false)", () => {
    const meeting = pipeline.importFile({ filePath: "/c/broken.m4a" });

    supervisor.emit(IMPORT_FILE_DONE_EVENT, {
      meetingId: meeting.id,
      ok: false,
      transcription: "error",
      diarization: "skipped",
      summary: "skipped",
      speakers: [],
      diarizationBackend: "",
      summaryProvider: "",
      summaryModel: "",
      indexText: "",
      note: "file has no audio stream",
    });

    expect(store.getMeeting(meeting.id)?.status).toBe("error");
    expect(statuses).toContain(`${meeting.id}:error`);
  });

  it("ignores an importFileDone for an unknown / not-in-flight meeting", () => {
    pipeline.importFile({ filePath: "/c/a.wav" });
    const before = statuses.length;
    supervisor.emit(IMPORT_FILE_DONE_EVENT, { meetingId: "not-ours", ok: true, indexText: "" });
    expect(statuses.length).toBe(before); // no extra status emitted.
  });
});
