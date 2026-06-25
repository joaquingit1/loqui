/**
 * PRD-13 audio-retention tests for the post-processing pipeline (hermetic).
 *
 * Asserts the `delete-after-processing` policy: the per-source WAVs are removed
 * AFTER `postProcessDone` (i.e. once diarization has consumed them), and ONLY
 * for that policy — `keep` and `never-save` never trigger the delete here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AudioRetentionPolicy,
  Meeting,
  PostProcessDone,
  ProviderConfig,
} from "@loqui/shared";
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
  indexText: "hello",
  note: "",
};

function runFinalize(retention: AudioRetentionPolicy): string[] {
  const deleted: string[] = [];
  const supervisor = makeSupervisor();
  const pipeline = createPostProcessPipeline({
    supervisor,
    store: makeStore(meeting("m1")),
    providerKeys: keys,
    hfKeystore: hf,
    getAudioRetention: () => retention,
    deleteAudioFiles: (meetingId) => deleted.push(meetingId),
  });
  pipeline.onMeetingProcessing(meeting("m1"));
  supervisor.emit("audioFinalized", { meetingId: "m1", source: "system" });
  supervisor.emit("postProcessDone", done);
  pipeline.dispose();
  return deleted;
}

describe("audio retention in the pipeline finalize", () => {
  it("delete-after-processing removes the WAVs after postProcessDone", () => {
    expect(runFinalize("delete-after-processing")).toEqual(["m1"]);
  });

  it("keep never removes the WAVs", () => {
    expect(runFinalize("keep")).toEqual([]);
  });

  it("never-save never triggers a delete here (the WAVs were never written)", () => {
    expect(runFinalize("never-save")).toEqual([]);
  });

  it("a delete failure does not flip the meeting out of done", () => {
    const supervisor = makeSupervisor();
    const store = makeStore(meeting("m1"));
    const pipeline = createPostProcessPipeline({
      supervisor,
      store,
      providerKeys: keys,
      hfKeystore: hf,
      getAudioRetention: () => "delete-after-processing",
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
