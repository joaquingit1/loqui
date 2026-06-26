/**
 * Hermetic tests for the PURE diarized-transcript render + index-text helpers
 * (PRD-5). No I/O, no model, no electron — exhaustively unit-testable.
 *
 * Asserts the `.md` render matches the sidecar's `render_diarized_md` format
 * (`[hh:mm:ss] <speaker>: <text>`, display-name override, CR/LF collapse,
 * trailing newline, empty-when-no-segments) so a main-driven rename rewrite
 * reproduces the same file the sidecar first wrote.
 */
import { describe, expect, it } from "vitest";
import type { DiarizedTranscript, Summary } from "@loqui/shared";
import { buildIndexText, renderDiarizedMd } from "./render.js";

function diarized(segments: DiarizedTranscript["segments"]): DiarizedTranscript {
  return {
    meetingId: "m1",
    version: 1,
    diarized: true,
    backend: "fake",
    speakers: ["Speaker 1", "Speaker 2"],
    segments,
  };
}

describe("renderDiarizedMd", () => {
  it("renders one line per segment as [hh:mm:ss] <speaker>: <text>", () => {
    const md = renderDiarizedMd(
      diarized([
        { segId: "s1", source: "mic", text: "Hello there", tStart: 0, tEnd: 2, speaker: "You", displayName: null },
        { segId: "s2", source: "system", text: "Hi", tStart: 65, tEnd: 67, speaker: "Speaker 1", displayName: null },
        { segId: "s3", source: "system", text: "Later", tStart: 3661, tEnd: 3663, speaker: "Speaker 2", displayName: null },
      ]),
    );
    expect(md).toBe(
      "[00:00:00] You: Hello there\n" +
        "[00:01:05] Speaker 1: Hi\n" +
        "[01:01:01] Speaker 2: Later\n",
    );
  });

  it("uses the displayName (rename) when set, else the stable label", () => {
    const md = renderDiarizedMd(
      diarized([
        { segId: "s1", source: "system", text: "Hey", tStart: 0, tEnd: 1, speaker: "Speaker 1", displayName: "Alex" },
        { segId: "s2", source: "system", text: "Yo", tStart: 1, tEnd: 2, speaker: "Speaker 2", displayName: "  " },
      ]),
    );
    // displayName "Alex" wins; whitespace-only displayName falls back to the label.
    expect(md).toBe("[00:00:00] Alex: Hey\n[00:00:01] Speaker 2: Yo\n");
  });

  it("collapses CR/LF in text to spaces and right-trims the line", () => {
    const md = renderDiarizedMd(
      diarized([
        { segId: "s1", source: "mic", text: "line one\nline two\r\nthree   ", tStart: 0, tEnd: 1, speaker: "You", displayName: null },
      ]),
    );
    expect(md).toBe("[00:00:00] You: line one line two  three\n");
  });

  it("is empty (no trailing newline) when there are no segments", () => {
    expect(renderDiarizedMd(diarized([]))).toBe("");
  });

  it("clamps a negative/zero tStart to 00:00:00", () => {
    const md = renderDiarizedMd(
      diarized([
        { segId: "s1", source: "mic", text: "x", tStart: -5, tEnd: 0, speaker: "You", displayName: null },
      ]),
    );
    expect(md.startsWith("[00:00:00]")).toBe(true);
  });
});

describe("buildIndexText", () => {
  const summary: Summary = {
    meetingId: "m1",
    version: 1,
    title: "",
    overview: "",
    tldr: "We shipped the thing.",    decisions: ["Use pyannote 3.1"],
    actionItems: [
      { text: "Write tests", owner: "Alex" },
      { text: "Deploy", owner: null },
    ],
    topics: ["Diarization"],
    provider: "fake",
    model: "scripted",
    generatedAt: "2026-06-23T00:00:00.000Z",
  };

  it("concatenates diarized segment text (with the display name) + summary fields", () => {
    const d = diarized([
      { segId: "s1", source: "mic", text: "Hello", tStart: 0, tEnd: 1, speaker: "You", displayName: null },
      { segId: "s2", source: "system", text: "Hi", tStart: 1, tEnd: 2, speaker: "Speaker 1", displayName: "Alex" },
      { segId: "s3", source: "system", text: "   ", tStart: 2, tEnd: 3, speaker: "Speaker 2", displayName: null },
    ]);
    const text = buildIndexText(d, summary);
    expect(text).toContain("You: Hello");
    expect(text).toContain("Alex: Hi");
    // Blank segment text is skipped.
    expect(text).not.toContain("Speaker 2:");
    expect(text).toContain("We shipped the thing.");
    expect(text).toContain("Use pyannote 3.1");
    expect(text).toContain("Alex: Write tests");
    expect(text).toContain("Deploy");
    expect(text).toContain("Diarization");
  });

  it("handles a null diarized transcript (summary-only index)", () => {
    const text = buildIndexText(null, summary);
    expect(text).toContain("We shipped the thing.");
    expect(text).not.toContain("You:");
  });

  it("handles a null summary (diarized-only index)", () => {
    const d = diarized([
      { segId: "s1", source: "mic", text: "Hello", tStart: 0, tEnd: 1, speaker: "You", displayName: null },
    ]);
    expect(buildIndexText(d, null)).toBe("You: Hello");
  });

  it("is empty when both inputs are null", () => {
    expect(buildIndexText(null, null)).toBe("");
  });
});
