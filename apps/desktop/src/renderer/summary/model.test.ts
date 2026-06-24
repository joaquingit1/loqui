/**
 * Pure model-helper tests (node env via vitest path globs — these live under
 * src/renderer/** so run in jsdom, but they touch no DOM). Hermetic: no
 * window.loqui, no I/O.
 */
import { describe, expect, it } from "vitest";
import type { DiarizedTranscript, JobEvent } from "@loqui/shared";
import {
  allJobsTerminal,
  formatTimecode,
  isJobTerminal,
  isProcessing,
  isYou,
  progressPercent,
  reduceJob,
  speakerDisplay,
  speakerEntries,
  summaryHasContent,
} from "./model.js";

const job = (over: Partial<JobEvent>): JobEvent => ({
  jobId: "j1",
  kind: "summary",
  state: "running",
  progress: 0,
  error: null,
  ...over,
});

describe("progressPercent", () => {
  it("clamps and rounds 0..1 to an integer percent", () => {
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(0.5)).toBe(50);
    expect(progressPercent(0.333)).toBe(33);
    expect(progressPercent(1)).toBe(100);
    expect(progressPercent(2)).toBe(100);
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(Number.NaN)).toBe(0);
  });
});

describe("isJobTerminal", () => {
  it("treats done/error/canceled as terminal", () => {
    expect(isJobTerminal("done")).toBe(true);
    expect(isJobTerminal("error")).toBe(true);
    expect(isJobTerminal("canceled")).toBe(true);
    expect(isJobTerminal("queued")).toBe(false);
    expect(isJobTerminal("running")).toBe(false);
  });
});

describe("reduceJob / isProcessing / allJobsTerminal", () => {
  it("keeps the latest event per tracked kind and ignores transcription", () => {
    let m = reduceJob({}, job({ kind: "diarization", state: "running", progress: 0.2 }));
    m = reduceJob(m, job({ kind: "summary", state: "queued" }));
    m = reduceJob(m, job({ kind: "transcription", state: "running" }));
    expect(m.diarization?.progress).toBe(0.2);
    expect(m.summary?.state).toBe("queued");
    expect(m.transcription).toBeUndefined();

    // Latest wins for the same kind.
    m = reduceJob(m, job({ kind: "diarization", state: "done", progress: 1 }));
    expect(m.diarization?.state).toBe("done");
  });

  it("isProcessing is true while any tracked job is non-terminal", () => {
    expect(isProcessing({})).toBe(false);
    expect(isProcessing(reduceJob({}, job({ kind: "summary", state: "running" })))).toBe(true);
    expect(isProcessing(reduceJob({}, job({ kind: "summary", state: "done" })))).toBe(false);
  });

  it("allJobsTerminal requires at least one reported job, all terminal", () => {
    expect(allJobsTerminal({})).toBe(false);
    let m = reduceJob({}, job({ kind: "diarization", state: "done" }));
    expect(allJobsTerminal(m)).toBe(true);
    m = reduceJob(m, job({ kind: "summary", state: "running" }));
    expect(allJobsTerminal(m)).toBe(false);
    m = reduceJob(m, job({ kind: "summary", state: "error" }));
    expect(allJobsTerminal(m)).toBe(true);
  });
});

describe("formatTimecode", () => {
  it("formats seconds as m:ss / h:mm:ss", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(5)).toBe("0:05");
    expect(formatTimecode(65)).toBe("1:05");
    expect(formatTimecode(3661)).toBe("1:01:01");
    expect(formatTimecode(-3)).toBe("0:00");
  });
});

describe("speaker helpers", () => {
  it("isYou / speakerDisplay resolve labels and renames", () => {
    expect(isYou({ speaker: "You" })).toBe(true);
    expect(isYou({ speaker: "Speaker 1" })).toBe(false);
    expect(speakerDisplay({ speaker: "Speaker 1", displayName: null })).toBe("Speaker 1");
    expect(speakerDisplay({ speaker: "Speaker 1", displayName: "Alex" })).toBe("Alex");
    expect(speakerDisplay({ speaker: "Speaker 1", displayName: "  " })).toBe("Speaker 1");
  });

  it("speakerEntries lists You first, then system labels with their renames", () => {
    const d: DiarizedTranscript = {
      meetingId: "m1",
      version: 1,
      diarized: true,
      backend: "fake",
      speakers: ["Speaker 1", "Speaker 2"],
      segments: [
        { segId: "a", source: "mic", text: "Hi", tStart: 0, tEnd: 1, speaker: "You", displayName: null },
        { segId: "b", source: "system", text: "Hello", tStart: 1, tEnd: 2, speaker: "Speaker 1", displayName: "Alex" },
        { segId: "c", source: "system", text: "Hey", tStart: 2, tEnd: 3, speaker: "Speaker 2", displayName: null },
      ],
    };
    const entries = speakerEntries(d);
    expect(entries.map((e) => e.label)).toEqual(["You", "Speaker 1", "Speaker 2"]);
    expect(entries.find((e) => e.label === "Speaker 1")?.displayName).toBe("Alex");
    expect(entries.find((e) => e.label === "You")?.displayName).toBeNull();
  });
});

describe("summaryHasContent", () => {
  it("is false for an all-empty summary, true when any section has content", () => {
    expect(summaryHasContent({ tldr: "", decisions: [], actionItems: [], topics: [] })).toBe(false);
    expect(summaryHasContent({ tldr: "  ", decisions: ["  "], actionItems: [{ text: "" }], topics: [""] })).toBe(false);
    expect(summaryHasContent({ tldr: "x", decisions: [], actionItems: [], topics: [] })).toBe(true);
    expect(summaryHasContent({ tldr: "", decisions: ["d"], actionItems: [], topics: [] })).toBe(true);
    expect(summaryHasContent({ tldr: "", decisions: [], actionItems: [{ text: "do it" }], topics: [] })).toBe(true);
    expect(summaryHasContent({ tldr: "", decisions: [], actionItems: [], topics: ["t"] })).toBe(true);
  });
});
