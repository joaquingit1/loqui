/**
 * PRD-13 export-transform tests (PURE, hermetic).
 *
 * Each format is asserted from a FIXTURE diarized transcript + summary: SRT/VTT
 * timing correctness (exact timestamp formatting), JSON schema, Obsidian YAML
 * frontmatter parse, and determinism. The live-transcript fallback parse is
 * asserted directly. Binary (PDF/DOCX) magic bytes are asserted in service.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { DiarizedTranscript, Meeting, Summary } from "@loqui/shared";
import { buildExportModel, parseLiveTranscript } from "./model.js";
import {
  formatSrtTimestamp,
  formatVttTimestamp,
  toJson,
  toMarkdown,
  toObsidian,
  toSrt,
  toVtt,
} from "./transforms.js";

const MEETING: Meeting = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Roadmap sync",
  platform: "google-meet",
  startedAt: "2026-06-24T15:00:00.000Z",
  endedAt: "2026-06-24T15:30:00.000Z",
  status: "done",
  kind: "meeting",
  participants: [],
  modelVersions: {},
  createdAt: "2026-06-24T15:00:00.000Z",
  updatedAt: "2026-06-24T15:30:00.000Z",
};

const DIARIZED: DiarizedTranscript = {
  meetingId: MEETING.id,
  version: 1,
  diarized: true,
  backend: "pyannote/speaker-diarization-3.1",
  speakers: ["Speaker 1"],
  segments: [
    {
      segId: "s1",
      source: "mic",
      text: "Hey, can you hear me?",
      tStart: 1.5,
      tEnd: 3.25,
      speaker: "You",
      displayName: null,
    },
    {
      segId: "s2",
      source: "system",
      text: "Yep, loud and clear.",
      tStart: 3.25,
      tEnd: 5,
      speaker: "Speaker 1",
      displayName: "Alex",
    },
    {
      segId: "s3",
      source: "system",
      text: "Let's start with the roadmap.",
      tStart: 65.4,
      tEnd: 70.123,
      speaker: "Speaker 1",
      displayName: "Alex",
    },
  ],
};

const SUMMARY: Summary = {
  meetingId: MEETING.id,
  version: 1,
  tldr: "The team aligned on the Q3 roadmap.",
  decisions: ["Ship export by July", "Default content protection on"],
  actionItems: [
    { text: "Draft the export PRD", owner: "Alex" },
    { text: "Review privacy defaults", owner: null },
  ],
  topics: ["roadmap", "privacy"],
  provider: "fake",
  model: "fake-model",
  generatedAt: "2026-06-24T15:31:00.000Z",
};

function model() {
  return buildExportModel({
    meeting: MEETING,
    diarized: DIARIZED,
    liveTranscript: "",
    summary: SUMMARY,
  });
}

/**
 * Minimal YAML-frontmatter parser for the test (no YAML dep): reads the block
 * between the leading `---` fences and returns a key -> value map. Inline lists
 * (`[a, b]`) become arrays of unquoted scalars; plain scalars are unquoted.
 */
function parseFrontmatter(md: string): Record<string, string | string[]> {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) throw new Error("no frontmatter block found");
  const out: Record<string, string | string[]> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw!.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      out[key!] = inner === "" ? [] : inner.split(",").map((s) => unquote(s.trim()));
    } else {
      out[key!] = unquote(value);
    }
  }
  return out;
}

function unquote(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s;
}

describe("timestamp formatters", () => {
  it("formats SRT timestamps as hh:mm:ss,mmm", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(1.5)).toBe("00:00:01,500");
    expect(formatSrtTimestamp(65.4)).toBe("00:01:05,400");
    expect(formatSrtTimestamp(3661.789)).toBe("01:01:01,789");
  });

  it("formats VTT timestamps as hh:mm:ss.mmm", () => {
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    expect(formatVttTimestamp(70.123)).toBe("00:01:10.123");
  });

  it("clamps negative / NaN to zero", () => {
    expect(formatSrtTimestamp(-5)).toBe("00:00:00,000");
    expect(formatVttTimestamp(Number.NaN)).toBe("00:00:00.000");
  });
});

describe("toSrt", () => {
  it("produces well-formed, correctly-timed cues with the renamed speaker", () => {
    const srt = toSrt(model());
    const expected = [
      "1",
      "00:00:01,500 --> 00:00:03,250",
      "You: Hey, can you hear me?",
      "",
      "2",
      "00:00:03,250 --> 00:00:05,000",
      "Alex: Yep, loud and clear.",
      "",
      "3",
      "00:01:05,400 --> 00:01:10,123",
      "Alex: Let's start with the roadmap.",
      "",
    ].join("\n");
    expect(srt).toBe(expected);
  });
});

describe("toVtt", () => {
  it("starts with the WEBVTT header and uses dot-millisecond cue timings", () => {
    const vtt = toVtt(model());
    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:01.500 --> 00:00:03.250\nYou: Hey, can you hear me?");
    expect(vtt).toContain("00:01:05.400 --> 00:01:10.123\nAlex: Let's start with the roadmap.");
  });
});

describe("toJson", () => {
  it("emits structured segments + speakers + summary, source=diarized", () => {
    const parsed = JSON.parse(toJson(model()));
    expect(parsed.version).toBe(1);
    expect(parsed.source).toBe("diarized");
    expect(parsed.meeting.id).toBe(MEETING.id);
    expect(parsed.speakers).toEqual(["You", "Alex"]);
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[1]).toEqual({
      tStart: 3.25,
      tEnd: 5,
      speaker: "Alex",
      text: "Yep, loud and clear.",
    });
    expect(parsed.summary.tldr).toBe(SUMMARY.tldr);
  });
});

describe("toMarkdown / toObsidian", () => {
  it("emits parseable Obsidian YAML frontmatter + summary + transcript", () => {
    const md = toMarkdown(model());
    expect(md.startsWith("---\n")).toBe(true);
    const fm = parseFrontmatter(md);
    expect(fm.title).toBe("Roadmap sync");
    expect(fm.date).toBe("2026-06-24");
    expect(fm.source).toBe("loqui");
    expect(fm.kind).toBe("meeting");
    // attendees/speakers reflect the resolved (renamed) speakers.
    expect(fm.attendees).toContain("Alex");
    expect(md).toContain("## Summary");
    expect(md).toContain("- [ ] Draft the export PRD (@Alex)");
    expect(md).toContain("## Transcript");
    expect(md).toContain("**Alex** [00:01:05]: Let's start with the roadmap.");
    // The Obsidian alias is byte-identical to the markdown export here.
    expect(toObsidian(model())).toBe(md);
  });
});

describe("determinism", () => {
  it("renders byte-identical output across repeated calls", () => {
    expect(toSrt(model())).toBe(toSrt(model()));
    expect(toVtt(model())).toBe(toVtt(model()));
    expect(toJson(model())).toBe(toJson(model()));
    expect(toMarkdown(model())).toBe(toMarkdown(model()));
  });
});

describe("live-transcript fallback parse", () => {
  const LIVE = [
    "[00:00:01] You said: Hey, can you hear me?",
    "[00:00:03] They said: Yep, loud and clear.",
    "[00:01:05] They said: Let's start with the roadmap.",
    "",
  ].join("\n");

  it("parses [hh:mm:ss] You/They lines into timed segments", () => {
    const segs = parseLiveTranscript(LIVE);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ tStart: 1, speaker: "You", text: "Hey, can you hear me?" });
    expect(segs[1]).toMatchObject({ tStart: 3, speaker: "They", text: "Yep, loud and clear." });
    // Each segment's end is refined to the next start.
    expect(segs[0]!.tEnd).toBe(3);
    expect(segs[1]!.tEnd).toBe(65);
  });

  it("falls back to live when no diarized transcript exists (usedDiarized=false)", () => {
    const m = buildExportModel({
      meeting: MEETING,
      diarized: null,
      liveTranscript: LIVE,
      summary: SUMMARY,
    });
    expect(m.usedDiarized).toBe(false);
    expect(m.segments).toHaveLength(3);
    expect(toJson(m)).toContain('"source": "live"');
  });
});
