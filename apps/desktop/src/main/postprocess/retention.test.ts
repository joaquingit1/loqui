/**
 * Audio non-persistence tests for the post-processing pipeline (hermetic).
 *
 * Privacy guarantee: audio NEVER persists. The per-source WAVs are removed
 * UNCONDITIONALLY after `postProcessDone` (i.e. once the hi-fi re-transcription
 * + diarization have consumed them). A delete failure is best-effort and must
 * not flip the meeting out of `done`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Meeting, PostProcessDone, ProviderConfig } from "@loqui/shared";
import { createPostProcessPipeline } from "./pipeline.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loqui-retention-"));
  process.env.LOQUI_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.LOQUI_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function makeSupervisor() {
  let cb: ((event: string, data: unknown) => void) | null = null;
  return {
    emit(event: string, data: unknown) {
      cb?.(event, data);
    },
    sendControlNotification(): boolean {
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

function meeting(id: string): Meeting {
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
    calendarAttendees: [],
    titleEdited: false,
    createdAt: now,
    updatedAt: now,
  };
}

function makeStore(m: Meeting) {
  const meetings = new Map<string, Meeting>([[m.id, m]]);
  return {
    getMeeting: (id: string) => meetings.get(id) ?? null,
    updateMeeting: (id: string, patch: Partial<Meeting>): Meeting => {
      const cur = meetings.get(id)!;
      const next = { ...cur, ...patch, id };
      meetings.set(id, next);
      return next;
    },
    upsertSearchText: (): void => {},
  };
}

const providerConfig: ProviderConfig = {
  provider: "fake",
  model: "m",
  baseUrl: "b",
  ollamaModel: "o",
  cli: "claude",
  nativeModel: "",
  summaryTemplate: "",
};
const keys = {
  getProviderSettings: (): ProviderConfig => providerConfig,
  getApiKey: () => null,
};
const hf = { getHfToken: () => null, getDiarizationBackend: () => "auto" as const };

const done: PostProcessDone = {
  meetingId: "m1",
  diarization: "done",
  summary: "done",
  speakers: ["Speaker 1"],
  diarizationBackend: "fake",
  summaryProvider: "fake",
  summaryModel: "fake",
  title: "",
  indexText: "hello",
  note: "",
};

function runFinalize(): string[] {
  const deleted: string[] = [];
  const supervisor = makeSupervisor();
  const pipeline = createPostProcessPipeline({
    supervisor,
    store: makeStore(meeting("m1")),
    providerKeys: keys,
    hfKeystore: hf,
    deleteAudioFiles: (meetingId) => deleted.push(meetingId),
  });
  pipeline.onMeetingProcessing(meeting("m1"));
  supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });
  supervisor.emit("postProcessDone", done);
  pipeline.dispose();
  return deleted;
}

describe("audio non-persistence in the pipeline finalize", () => {
  it("ALWAYS removes the WAVs after postProcessDone (audio never persists)", () => {
    expect(runFinalize()).toEqual(["m1"]);
  });

  it("a delete failure does not flip the meeting out of done", () => {
    const supervisor = makeSupervisor();
    const store = makeStore(meeting("m1"));
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: keys,
      hfKeystore: hf,
      deleteAudioFiles: () => {
        throw new Error("disk busy");
      },
    });
    pipeline.onMeetingProcessing(meeting("m1"));
    supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });
    supervisor.emit("postProcessDone", done);
    expect(store.getMeeting("m1")!.status).toBe("done");
    pipeline.dispose();
  });
});
