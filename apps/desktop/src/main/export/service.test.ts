/**
 * PRD-13 ExportService integration tests (hermetic).
 *
 * Drives the REAL service over the REAL store under a temp LOQUI_DATA_DIR: each
 * format is exported from a fixture meeting (diarized transcript + summary +
 * live transcript) to actual files on disk, then validated:
 *   - text formats parse / contain expected content,
 *   - PDF starts with the `%PDF-` magic,
 *   - DOCX starts with the `PK` zip magic AND unzips to a valid OOXML (the
 *     `[Content_Types].xml` entry is present),
 *   - transcript.live.md stays BYTE-IDENTICAL (exports never touch it),
 *   - output is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV, type DiarizedTranscript, type Summary } from "@loqui/shared";
import { openStore, type MeetingStore } from "../store/index.js";
import {
  meetingDir,
  meetingDiarizedTranscriptJsonPath,
  meetingLiveTranscriptPath,
  meetingSummaryPath,
} from "../store/paths.js";
import { ExportService } from "./service.js";

let tmp: string;
let store: MeetingStore;
let exportDir: string;
let service: ExportService;

const LIVE_MD = [
  "[00:00:01] You said: Hey, can you hear me?",
  "[00:00:03] They said: Yep, loud and clear.",
  "",
].join("\n");

function seedMeeting(opts: { withDiarized: boolean }): string {
  const meeting = store.createMeeting({ title: "Export QA", platform: "zoom" });
  mkdirSync(meetingDir(meeting.id), { recursive: true });
  writeFileSync(meetingLiveTranscriptPath(meeting.id), LIVE_MD, "utf8");

  const summary: Summary = {
    meetingId: meeting.id,
    version: 1,
    title: "",
    overview: "",
    tldr: "Quick smoke of the export path.",    decisions: ["Export works"],
    actionItems: [{ text: "Ship it", owner: "QA" }],
    topics: ["export"],
    provider: "fake",
    model: "fake",
    generatedAt: "2026-06-24T00:00:00.000Z",
  };
  writeFileSync(meetingSummaryPath(meeting.id), JSON.stringify(summary), "utf8");

  if (opts.withDiarized) {
    const diarized: DiarizedTranscript = {
      meetingId: meeting.id,
      version: 1,
      diarized: true,
      backend: "fake",
      speakers: ["Speaker 1"],
      segments: [
        { segId: "s1", source: "mic", text: "Hey, can you hear me?", tStart: 1, tEnd: 3, speaker: "You", displayName: null },
        { segId: "s2", source: "system", text: "Yep, loud and clear.", tStart: 3, tEnd: 6, speaker: "Speaker 1", displayName: null },
      ],
    };
    writeFileSync(meetingDiarizedTranscriptJsonPath(meeting.id), JSON.stringify(diarized), "utf8");
  }
  return meeting.id;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-export-"));
  process.env[DATA_DIR_ENV] = tmp;
  store = openStore();
  exportDir = join(tmp, "exports-out");
  service = new ExportService({ store, getExportDir: () => exportDir });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("ExportService.exportMeeting", () => {
  it("writes non-empty MD/SRT/VTT/JSON files into the export dir (diarized source)", async () => {
    const id = seedMeeting({ withDiarized: true });

    for (const format of ["md", "obsidian", "srt", "vtt", "json"] as const) {
      const result = await service.exportMeeting({ meetingId: id, format });
      expect(result.usedDiarized).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      const content = readFileSync(result.path, "utf8");
      expect(content.length).toBeGreaterThan(0);
      if (format === "srt") expect(content).toContain("00:00:01,000 --> 00:00:03,000");
      if (format === "vtt") expect(content.startsWith("WEBVTT")).toBe(true);
      if (format === "json") expect(JSON.parse(content).source).toBe("diarized");
      if (format === "md" || format === "obsidian") expect(content.startsWith("---")).toBe(true);
    }
  });

  it("produces a valid PDF (starts with %PDF-)", async () => {
    const id = seedMeeting({ withDiarized: true });
    const result = await service.exportMeeting({ meetingId: id, format: "pdf" });
    const bytes = readFileSync(result.path);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("produces a valid DOCX (PK zip magic + OOXML [Content_Types].xml)", async () => {
    const id = seedMeeting({ withDiarized: true });
    const result = await service.exportMeeting({ meetingId: id, format: "docx" });
    const bytes = readFileSync(result.path);
    expect(bytes.byteLength).toBeGreaterThan(0);
    // Zip local-file-header magic "PK\x03\x04".
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    // A valid OOXML package always contains the [Content_Types].xml entry — its
    // filename appears in the zip's local-file-header bytes.
    expect(bytes.toString("latin1")).toContain("[Content_Types].xml");
  });

  it("falls back to the live transcript when no diarized transcript exists", async () => {
    const id = seedMeeting({ withDiarized: false });
    const result = await service.exportMeeting({ meetingId: id, format: "json" });
    expect(result.usedDiarized).toBe(false);
    const parsed = JSON.parse(readFileSync(result.path, "utf8"));
    expect(parsed.source).toBe("live");
    expect(parsed.segments).toHaveLength(2);
  });

  it("honors an outDir override", async () => {
    const id = seedMeeting({ withDiarized: true });
    const override = join(tmp, "custom-dir");
    const result = await service.exportMeeting({ meetingId: id, format: "md", outDir: override });
    expect(result.path.startsWith(override)).toBe(true);
  });

  it("NEVER mutates transcript.live.md (exports are read-only)", async () => {
    const id = seedMeeting({ withDiarized: true });
    const before = readFileSync(meetingLiveTranscriptPath(id));
    for (const format of ["md", "srt", "vtt", "json", "pdf", "docx"] as const) {
      await service.exportMeeting({ meetingId: id, format });
    }
    const after = readFileSync(meetingLiveTranscriptPath(id));
    expect(after.equals(before)).toBe(true);
  });

  it("renders deterministic text bytes for the same meeting+format", async () => {
    const id = seedMeeting({ withDiarized: true });
    const a = await service.exportMeeting({ meetingId: id, format: "srt" });
    const first = readFileSync(a.path);
    const b = await service.exportMeeting({ meetingId: id, format: "srt" });
    const second = readFileSync(b.path);
    expect(second.equals(first)).toBe(true);
  });

  it("throws on an unknown meeting", async () => {
    await expect(
      service.exportMeeting({ meetingId: "00000000-0000-4000-8000-000000000000", format: "md" }),
    ).rejects.toThrow(/unknown meeting/);
  });
});
