import { describe, expect, it } from "vitest";
import {
  importFileRequestSchema,
  importFileDoneSchema,
  importFileParamsSchema,
  IMPORT_FILE_EVENT,
  IMPORT_FILE_DONE_EVENT,
} from "./importfile.js";

describe("importFileRequestSchema (PRD-12)", () => {
  it("defaults providerConfig + diarizationBackend", () => {
    const parsed = importFileRequestSchema.parse({
      meetingId: "m1",
      filePath: "/tmp/clip.m4a",
    });
    expect(parsed.diarizationBackend).toBe("auto");
    expect(parsed.providerConfig.provider).toBe("fake");
    expect(parsed.apiKey ?? null).toBeNull();
  });

  it("requires a non-empty filePath", () => {
    expect(() => importFileRequestSchema.parse({ meetingId: "m1", filePath: "" })).toThrow();
  });
});

describe("importFileDoneSchema (PRD-12)", () => {
  it("defaults stages to skipped and ok to true", () => {
    const parsed = importFileDoneSchema.parse({ meetingId: "m1" });
    expect(parsed.ok).toBe(true);
    expect(parsed.transcription).toBe("skipped");
    expect(parsed.diarization).toBe("skipped");
    expect(parsed.summary).toBe("skipped");
    expect(parsed.speakers).toEqual([]);
  });
});

describe("importFileParamsSchema (PRD-12)", () => {
  it("accepts a path with an optional title", () => {
    const parsed = importFileParamsSchema.parse({ filePath: "/a/b.mp3", title: "Notes" });
    expect(parsed.title).toBe("Notes");
  });
});

describe("import event name constants", () => {
  it("are the stable wire strings", () => {
    expect(IMPORT_FILE_EVENT).toBe("importFile");
    expect(IMPORT_FILE_DONE_EVENT).toBe("importFileDone");
  });
});
