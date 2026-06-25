/**
 * Live-transcript model tests (node env via path — model is pure, no DOM).
 * Covers: append in order, partial-replace-in-place, final commit, finals are
 * terminal (never retracted), mic/system independence + referential stability,
 * and immutability.
 */
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@loqui/shared";
import {
  applySegment,
  applySegments,
  emptyTranscriptState,
  mergedSegments,
  SOURCE_LABEL,
} from "./model.js";

const MEETING = "22222222-2222-4222-8222-222222222222";

function seg(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    meetingId: MEETING,
    source: "mic",
    text: "",
    tStart: 0,
    tEnd: 0,
    status: "partial",
    segId: "s1",
    ...overrides,
  };
}

describe("transcript model", () => {
  it("starts empty for both sources", () => {
    const s = emptyTranscriptState();
    expect(s.mic).toEqual([]);
    expect(s.system).toEqual([]);
  });

  it("appends new segIds in arrival order within a source", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ segId: "a", text: "one" }));
    s = applySegment(s, seg({ segId: "b", text: "two" }));
    expect(s.mic.map((x) => x.segId)).toEqual(["a", "b"]);
    expect(s.mic.map((x) => x.text)).toEqual(["one", "two"]);
  });

  it("replaces a partial in place (same slot) as its text grows", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ segId: "a", text: "he" }));
    s = applySegment(s, seg({ segId: "b", text: "next" }));
    s = applySegment(s, seg({ segId: "a", text: "hello" })); // update earlier partial
    expect(s.mic.map((x) => x.segId)).toEqual(["a", "b"]); // order preserved
    expect(s.mic[0]!.text).toBe("hello");
    expect(s.mic[0]!.status).toBe("partial");
  });

  it("commits a partial to final in place keyed by segId", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ segId: "a", text: "hello", status: "partial" }));
    s = applySegment(s, seg({ segId: "a", text: "hello world", status: "final" }));
    expect(s.mic).toHaveLength(1);
    expect(s.mic[0]!.status).toBe("final");
    expect(s.mic[0]!.text).toBe("hello world");
  });

  it("never retracts or rewrites a committed final (finals are terminal)", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ segId: "a", text: "final text", status: "final" }));
    const afterFinal = s;
    // A stray later segment with the same segId must be ignored.
    s = applySegment(s, seg({ segId: "a", text: "mutated", status: "partial" }));
    expect(s).toBe(afterFinal); // same reference -> ignored
    expect(s.mic[0]!.text).toBe("final text");
    expect(s.mic[0]!.status).toBe("final");
  });

  it("keeps mic and system streams fully independent (same segId is not shared)", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ source: "mic", segId: "x", text: "you-said" }));
    s = applySegment(s, seg({ source: "system", segId: "x", text: "they-said" }));
    expect(s.mic).toHaveLength(1);
    expect(s.system).toHaveLength(1);
    expect(s.mic[0]!.text).toBe("you-said");
    expect(s.system[0]!.text).toBe("they-said");
  });

  it("returns the untouched stream by reference (the other stream is stable)", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ source: "mic", segId: "m1" }));
    const systemRef = s.system;
    s = applySegment(s, seg({ source: "mic", segId: "m2" }));
    expect(s.system).toBe(systemRef); // system list reference unchanged
  });

  it("does not mutate the input state (immutability)", () => {
    const s0 = emptyTranscriptState();
    const s1 = applySegment(s0, seg({ segId: "a" }));
    expect(s0.mic).toEqual([]); // original untouched
    expect(s1).not.toBe(s0);
    expect(s1.mic).not.toBe(s0.mic);
  });

  it("folds a batch in arrival order via applySegments", () => {
    const s = applySegments(emptyTranscriptState(), [
      seg({ segId: "a", text: "a", status: "partial" }),
      seg({ segId: "a", text: "aa", status: "final" }),
      seg({ source: "system", segId: "b", text: "b" }),
    ]);
    expect(s.mic).toHaveLength(1);
    expect(s.mic[0]!).toMatchObject({ text: "aa", status: "final" });
    expect(s.system).toHaveLength(1);
  });

  it("labels mic as You and system as They", () => {
    expect(SOURCE_LABEL.mic).toBe("You");
    expect(SOURCE_LABEL.system).toBe("They");
  });

  it("merges both streams into one time-ordered flow (for the editorial view)", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ source: "system", segId: "b", tStart: 2, text: "they" }));
    s = applySegment(s, seg({ source: "mic", segId: "a", tStart: 5, text: "you" }));
    s = applySegment(s, seg({ source: "system", segId: "c", tStart: 9, text: "again" }));
    const merged = mergedSegments(s);
    expect(merged.map((m) => m.segId)).toEqual(["b", "a", "c"]);
    // Each line keeps its own source so the view can attribute the speaker.
    expect(merged.map((m) => m.source)).toEqual(["system", "mic", "system"]);
  });

  it("keeps equal-timestamp lines stable by first-seen order", () => {
    let s = emptyTranscriptState();
    s = applySegment(s, seg({ source: "mic", segId: "m", tStart: 4, text: "you" }));
    s = applySegment(s, seg({ source: "system", segId: "s", tStart: 4, text: "they" }));
    expect(mergedSegments(s).map((m) => m.segId)).toEqual(["m", "s"]);
  });
});
