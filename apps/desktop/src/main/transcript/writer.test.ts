/**
 * Hermetic tests for the append-only TranscriptWriter (PRD-3).
 *
 * Pins LOQUI_DATA_DIR at a temp dir so it writes only there, and asserts the
 * load-bearing invariants: final-only, one timestamped+attributed line per
 * confirmed segment, append-only (never rewritten), per-(meeting,segId) dedupe,
 * fsync-per-append crash-safety, and that the public surface exposes NO
 * mutation beyond append.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV, type TranscriptSegment } from "@loqui/shared";
import { createTranscriptWriter, type TranscriptWriterFs } from "./writer.js";
import { meetingLiveTranscriptPath } from "../store/paths.js";

const MID = "11111111-1111-4111-8111-111111111111";

function seg(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    meetingId: MID,
    source: "mic",
    text: "hello there",
    tStart: 4,
    tEnd: 6,
    status: "final",
    segId: "s1",
    ...over,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-writer-"));
  process.env[DATA_DIR_ENV] = tmp;
});

afterEach(() => {
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("TranscriptWriter", () => {
  it("appends a confirmed mic segment as a timestamped 'You said:' line", () => {
    const w = createTranscriptWriter();
    expect(w.appendConfirmedSegment(seg())).toBe(true);
    const out = readFileSync(meetingLiveTranscriptPath(MID), "utf8");
    expect(out).toBe("[00:00:04] You said: hello there\n");
  });

  it("labels a system segment as 'They said:'", () => {
    const w = createTranscriptWriter();
    w.appendConfirmedSegment(seg({ source: "system", text: "loud and clear", tStart: 7 }));
    const out = readFileSync(meetingLiveTranscriptPath(MID), "utf8");
    expect(out).toBe("[00:00:07] They said: loud and clear\n");
  });

  it("is append-only: a second segment extends the file, never rewrites", () => {
    const w = createTranscriptWriter();
    w.appendConfirmedSegment(seg({ segId: "s1", text: "first", tStart: 1 }));
    w.appendConfirmedSegment(seg({ segId: "s2", text: "second", tStart: 2 }));
    const out = readFileSync(meetingLiveTranscriptPath(MID), "utf8");
    expect(out).toBe("[00:00:01] You said: first\n[00:00:02] You said: second\n");
  });

  it("ignores partial segments (only final is written)", () => {
    const w = createTranscriptWriter();
    expect(w.appendConfirmedSegment(seg({ status: "partial" }))).toBe(false);
    expect(w.appendConfirmedSegment(seg())).toBe(true);
    const out = readFileSync(meetingLiveTranscriptPath(MID), "utf8");
    expect(out).toBe("[00:00:04] You said: hello there\n");
  });

  it("dedupes repeated segIds per meeting (no duplicate line)", () => {
    const w = createTranscriptWriter();
    expect(w.appendConfirmedSegment(seg({ segId: "dup" }))).toBe(true);
    expect(w.appendConfirmedSegment(seg({ segId: "dup" }))).toBe(false);
    const out = readFileSync(meetingLiveTranscriptPath(MID), "utf8");
    expect(out.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("collapses embedded newlines so one segment is always one line", () => {
    const w = createTranscriptWriter();
    w.appendConfirmedSegment(seg({ text: "line one\nline two" }));
    const out = readFileSync(meetingLiveTranscriptPath(MID), "utf8");
    expect(out).toBe("[00:00:04] You said: line one line two\n");
  });

  it("fsyncs after each append (crash-safety) and never throws on fs error", () => {
    const fsSpy: TranscriptWriterFs = {
      mkdirSync: vi.fn(),
      openSync: vi.fn(() => 42 as unknown as number),
      appendFileSync: vi.fn(),
      fsyncSync: vi.fn(),
      closeSync: vi.fn(),
    };
    const w = createTranscriptWriter({ fs: fsSpy });
    w.appendConfirmedSegment(seg());
    expect(fsSpy.appendFileSync).toHaveBeenCalledTimes(1);
    expect(fsSpy.fsyncSync).toHaveBeenCalledTimes(1);
    expect(fsSpy.closeSync).toHaveBeenCalledTimes(1);

    // A throwing append must be swallowed (returns false), not propagated.
    const throwingFs: TranscriptWriterFs = {
      ...fsSpy,
      appendFileSync: vi.fn(() => {
        throw new Error("ENOSPC");
      }),
    };
    const w2 = createTranscriptWriter({ fs: throwingFs });
    expect(() => w2.appendConfirmedSegment(seg())).not.toThrow();
    expect(w2.appendConfirmedSegment(seg())).toBe(false);
  });

  it("exposes NO mutation beyond appendConfirmedSegment", () => {
    const w = createTranscriptWriter();
    expect(Object.keys(w)).toEqual(["appendConfirmedSegment"]);
  });
});
