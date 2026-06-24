/**
 * Hermetic, PURE tests for the speaker-name correlation engine (PRD-6).
 *
 * The engine is a deterministic function of (diarized, activity, params) — no
 * I/O, no Date.now, no randomness — so these are pure fixture tables. Covers:
 * exact overlap, gaps, partial overlap, simultaneous speakers, unknown names,
 * clock skew, empty inputs, ambiguity (stays Speaker N), and the "You" mic label
 * never being resolved.
 *
 * CLOCK CONVENTION: activity `ts` is epoch ms; turns are seconds-from-start. The
 * fixtures use a meeting start of 1_000_000 ms so `ts = 1_000_000 + sec*1000`
 * lands a speaking event at `sec` seconds into the meeting.
 */
import { describe, expect, it } from "vitest";
import type {
  DiarizedSegment,
  DiarizedTranscript,
  SpeakerActivityEvent,
} from "@loqui/shared";
import { correlateSpeakerNames } from "./correlate.js";

const START = 1_000_000; // meeting start, epoch ms.
/** Build an activity event at `sec` seconds into the meeting. */
const at = (sec: number, name: string, speaking: boolean): SpeakerActivityEvent => ({
  ts: START + sec * 1000,
  name,
  speaking,
});

function seg(
  segId: string,
  speaker: string,
  tStart: number,
  tEnd: number,
  source: "mic" | "system" = "system",
): DiarizedSegment {
  return { segId, source, text: segId, tStart, tEnd, speaker, displayName: null };
}

function diarized(segments: DiarizedSegment[], meetingId = "m1"): DiarizedTranscript {
  return {
    meetingId,
    version: 1,
    diarized: true,
    backend: "fake",
    speakers: [],
    segments,
  };
}

const params = { meetingStartEpochMs: START };

describe("correlateSpeakerNames — exact / clean overlap", () => {
  it("resolves a speaker whose turn is fully covered by one participant's speaking interval", () => {
    const d = diarized([seg("s1", "Speaker 1", 10, 20)]);
    const activity = [at(9, "Alice", true), at(21, "Alice", false)];
    const result = correlateSpeakerNames(d, activity, params);
    const r = result.resolutions.find((x) => x.speaker === "Speaker 1")!;
    expect(r.name).toBe("Alice");
    expect(r.apply).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.coveragePct).toBeGreaterThan(0.9);
  });

  it("maps two distinct speakers to two distinct participants", () => {
    const d = diarized([seg("s1", "Speaker 1", 0, 10), seg("s2", "Speaker 2", 20, 30)]);
    const activity = [
      at(0, "Alice", true),
      at(10, "Alice", false),
      at(20, "Bob", true),
      at(30, "Bob", false),
    ];
    const result = correlateSpeakerNames(d, activity, params);
    const byLabel = Object.fromEntries(result.resolutions.map((r) => [r.speaker, r]));
    expect(byLabel["Speaker 1"]!.name).toBe("Alice");
    expect(byLabel["Speaker 1"]!.apply).toBe(true);
    expect(byLabel["Speaker 2"]!.name).toBe("Bob");
    expect(byLabel["Speaker 2"]!.apply).toBe(true);
  });
});

describe("correlateSpeakerNames — gaps & partial overlap", () => {
  it("resolves on partial overlap when it dominates", () => {
    // Speaker 1 turn 10..20; Alice speaks 12..25 (overlap 8s of the 10s turn).
    const d = diarized([seg("s1", "Speaker 1", 10, 20)]);
    const activity = [at(12, "Alice", true), at(25, "Alice", false)];
    const r = correlateSpeakerNames(d, activity, params).resolutions[0]!;
    expect(r.name).toBe("Alice");
    expect(r.apply).toBe(true);
  });

  it("a gap (no overlapping activity) leaves the speaker unresolved (apply:false)", () => {
    // Speaker 1 turn 10..20; Alice only speaks far away 50..60 — no overlap.
    const d = diarized([seg("s1", "Speaker 1", 10, 20)]);
    const activity = [at(50, "Alice", true), at(60, "Alice", false)];
    const r = correlateSpeakerNames(d, activity, params).resolutions[0]!;
    expect(r.apply).toBe(false);
    // Stays Speaker N: the support is ~0.
    expect(r.support).toBe(0);
  });
});

describe("correlateSpeakerNames — simultaneous / ambiguous", () => {
  it("ambiguous speaker (two participants overlap nearly equally) stays Speaker N", () => {
    // Speaker 1 turn 0..10; Alice and Bob each speak the full 0..10 window.
    const d = diarized([seg("s1", "Speaker 1", 0, 10)]);
    const activity = [
      at(0, "Alice", true),
      at(10, "Alice", false),
      at(0, "Bob", true),
      at(10, "Bob", false),
    ];
    const r = correlateSpeakerNames(d, activity, params).resolutions[0]!;
    // A near-tie => low dominance => low confidence => not applied.
    expect(r.apply).toBe(false);
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("picks the dominant participant when one clearly overlaps more", () => {
    // Speaker 1 turn 0..10; Alice 0..9 (9s), Bob 9..10 (1s) => Alice dominates.
    const d = diarized([seg("s1", "Speaker 1", 0, 10)]);
    const activity = [
      at(0, "Alice", true),
      at(9, "Alice", false),
      at(9, "Bob", true),
      at(10, "Bob", false),
    ];
    const r = correlateSpeakerNames(d, activity, {
      meetingStartEpochMs: START,
      skewToleranceMs: 0,
    }).resolutions[0]!;
    expect(r.name).toBe("Alice");
    expect(r.apply).toBe(true);
  });
});

describe("correlateSpeakerNames — unknown names & 'You'", () => {
  it("never resolves the mic 'You' label", () => {
    const d = diarized([seg("s1", "You", 0, 10, "mic"), seg("s2", "Speaker 1", 0, 10)]);
    const activity = [at(0, "Alice", true), at(10, "Alice", false)];
    const result = correlateSpeakerNames(d, activity, params);
    expect(result.resolutions.find((r) => r.speaker === "You")).toBeUndefined();
    expect(result.resolutions.find((r) => r.speaker === "Speaker 1")!.name).toBe("Alice");
  });

  it("normalizes a '(You)' suffix off the participant name", () => {
    const d = diarized([seg("s1", "Speaker 1", 0, 10)]);
    const activity = [at(0, "Alice (You)", true), at(10, "Alice (You)", false)];
    const r = correlateSpeakerNames(d, activity, params).resolutions[0]!;
    expect(r.name).toBe("Alice");
  });

  it("ignores blank participant names", () => {
    const d = diarized([seg("s1", "Speaker 1", 0, 10)]);
    const activity = [at(0, "", true), at(10, "", false)];
    const r = correlateSpeakerNames(d, activity, params).resolutions[0]!;
    expect(r.apply).toBe(false);
    expect(result_participants(d, activity)).toEqual([]);
  });
});

function result_participants(d: DiarizedTranscript, a: SpeakerActivityEvent[]): string[] {
  return correlateSpeakerNames(d, a, params).participants;
}

describe("correlateSpeakerNames — clock skew", () => {
  it("resolves despite a +1s extension/meeting clock skew within tolerance", () => {
    // Turn 10..20. Alice's speaking events are shifted +1s late (11..21). With
    // the default 1500ms skew tolerance the widened interval still overlaps.
    const d = diarized([seg("s1", "Speaker 1", 10, 20)]);
    const activity = [at(11, "Alice", true), at(21, "Alice", false)];
    const r = correlateSpeakerNames(d, activity, params).resolutions[0]!;
    expect(r.name).toBe("Alice");
    expect(r.apply).toBe(true);
  });

  it("an unknown meetingStartEpochMs (0) resolves NOTHING — never confidently mislabels", () => {
    // Without a finite anchor the engine cannot place activity against the
    // seconds-from-start turn axis. It MUST NOT fall back to the earliest event:
    // a late first capture would otherwise shift onto t=0 and confidently
    // mislabel a different speaker (a "no bad data" violation). So an unknown
    // start applies nothing — the meeting keeps its generic `Speaker N` labels.
    const d = diarized([seg("s1", "Speaker 1", 0, 10)]);
    const activity = [at(0, "Alice", true), at(10, "Alice", false)];
    const result = correlateSpeakerNames(d, activity); // no params => start unknown.
    expect(result.resolutions.every((r) => !r.apply)).toBe(true);
    expect(result.resolutions.every((r) => r.name === "")).toBe(true);
  });

  it("does NOT confidently mislabel when the first captured event is late (unknown start)", () => {
    // The adversarial case behind the fix: the extension missed the first 60s and
    // only captured Bob (Speaker 2's real name) at 60..70. With an unknown start a
    // naive earliest-event anchor would shift Bob onto Speaker 1's 0..10 turn and
    // resolve Speaker 1 -> "Bob" with confidence 1 (WRONG). The corrected engine
    // anchors nowhere and applies nothing.
    const d = diarized([
      seg("s1", "Speaker 1", 0, 10),
      seg("s2", "Speaker 2", 60, 70),
    ]);
    const activity = [at(60_000, "Bob", true), at(70_000, "Bob", false)];
    const result = correlateSpeakerNames(d, activity); // no params => start unknown.
    const s1 = result.resolutions.find((r) => r.speaker === "Speaker 1");
    expect(s1?.apply).not.toBe(true);
    expect(s1?.name === "Bob" && s1.apply).not.toBe(true);
  });
});

describe("correlateSpeakerNames — empty / degenerate (graceful)", () => {
  it("empty activity yields an empty-ish result (apply nothing)", () => {
    const d = diarized([seg("s1", "Speaker 1", 0, 10)]);
    const result = correlateSpeakerNames(d, []);
    expect(result.usedActivityEvents).toBe(0);
    expect(result.participants).toEqual([]);
    expect(result.resolutions.every((r) => !r.apply)).toBe(true);
    expect(result.coveragePct).toBe(0);
  });

  it("no system speakers (only 'You') yields no resolutions", () => {
    const d = diarized([seg("s1", "You", 0, 10, "mic")]);
    const result = correlateSpeakerNames(
      d,
      [at(0, "Alice", true), at(10, "Alice", false)],
      params,
    );
    expect(result.resolutions).toEqual([]);
  });

  it("does not throw on malformed-ish inputs and stays deterministic", () => {
    const d = { meetingId: "x", segments: undefined } as unknown as DiarizedTranscript;
    const r1 = correlateSpeakerNames(d, undefined as unknown as SpeakerActivityEvent[]);
    const r2 = correlateSpeakerNames(d, undefined as unknown as SpeakerActivityEvent[]);
    expect(r1).toEqual(r2); // deterministic.
    expect(r1.resolutions).toEqual([]);
  });

  it("is a deterministic pure function (same inputs -> identical output)", () => {
    const d = diarized([seg("s1", "Speaker 1", 0, 10), seg("s2", "Speaker 2", 11, 20)]);
    const activity = [
      at(0, "Alice", true),
      at(10, "Alice", false),
      at(11, "Bob", true),
      at(20, "Bob", false),
    ];
    expect(correlateSpeakerNames(d, activity, params)).toEqual(
      correlateSpeakerNames(d, activity, params),
    );
  });
});
