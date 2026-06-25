/**
 * PURE, DETERMINISTIC export transforms (PRD-13).
 *
 * Each function takes the normalized {@link ExportModel} and returns a string
 * (text formats) — no fs, no Electron, no Date.now (timestamps come from the
 * model). The binary formats (PDF/DOCX) live in ./binary.ts (they need the
 * pdfkit/docx libs); these are the trivially-testable text producers asserted in
 * the integration tests (SRT/VTT timing, Obsidian frontmatter, JSON schema).
 *
 * Exports are READ-ONLY over the canonical transcript — these functions cannot
 * (and do not) write anything.
 */
import type { ExportModel, ExportSegment } from "./model.js";

// --- Timestamp formatters -----------------------------------------------------

/** Clamp a seconds value to a finite, non-negative number. */
function clampSeconds(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Format seconds as an SRT timestamp `hh:mm:ss,mmm` (comma decimal separator).
 * Hours are zero-padded to 2 digits (grow past 2 for very long meetings).
 */
export function formatSrtTimestamp(seconds: number): string {
  return formatClock(clampSeconds(seconds), ",");
}

/**
 * Format seconds as a WebVTT timestamp `hh:mm:ss.mmm` (dot decimal separator).
 */
export function formatVttTimestamp(seconds: number): string {
  return formatClock(clampSeconds(seconds), ".");
}

function formatClock(seconds: number, msSep: "," | "."): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

// --- SRT -----------------------------------------------------------------------

/**
 * Render the model as SubRip (.srt): 1-based cue index, `start --> end`
 * timestamps (comma ms), then `Speaker: text`, cues separated by a blank line.
 */
export function toSrt(model: ExportModel): string {
  const cues = model.segments.map((seg, i) => {
    const start = formatSrtTimestamp(seg.tStart);
    const end = formatSrtTimestamp(Math.max(seg.tEnd, seg.tStart));
    return `${i + 1}\n${start} --> ${end}\n${cueText(seg)}`;
  });
  return cues.join("\n\n") + (cues.length > 0 ? "\n" : "");
}

// --- VTT -----------------------------------------------------------------------

/**
 * Render the model as WebVTT (.vtt): the `WEBVTT` header, then cues with
 * `start --> end` (dot ms) and `Speaker: text`, separated by blank lines.
 */
export function toVtt(model: ExportModel): string {
  const header = "WEBVTT\n";
  const cues = model.segments.map((seg) => {
    const start = formatVttTimestamp(seg.tStart);
    const end = formatVttTimestamp(Math.max(seg.tEnd, seg.tStart));
    return `${start} --> ${end}\n${cueText(seg)}`;
  });
  return cues.length > 0 ? `${header}\n${cues.join("\n\n")}\n` : `${header}`;
}

/** `Speaker: text` for a subtitle cue (single-lined). */
function cueText(seg: ExportSegment): string {
  const text = seg.text.replace(/[\r\n]+/g, " ").trim();
  return seg.speaker ? `${seg.speaker}: ${text}` : text;
}

// --- JSON ----------------------------------------------------------------------

/** The structured JSON export document shape (stable, versioned). */
export interface ExportJsonDocument {
  version: number;
  meeting: {
    id: string;
    title: string;
    platform: string | null;
    kind: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    createdAt: string;
  };
  source: "diarized" | "live";
  speakers: string[];
  segments: Array<{
    tStart: number;
    tEnd: number;
    speaker: string;
    text: string;
  }>;
  summary: ExportModel["summary"];
}

/**
 * Render the model as structured JSON: meeting metadata + speakers + segments +
 * summary. Pretty-printed with a trailing newline for stable diffs.
 */
export function toJson(model: ExportModel): string {
  const doc: ExportJsonDocument = {
    version: 1,
    meeting: {
      id: model.meeting.id,
      title: model.meeting.title,
      platform: model.meeting.platform,
      kind: model.meeting.kind,
      status: model.meeting.status,
      startedAt: model.meeting.startedAt,
      endedAt: model.meeting.endedAt,
      createdAt: model.meeting.createdAt,
    },
    source: model.usedDiarized ? "diarized" : "live",
    speakers: model.speakers,
    segments: model.segments.map((s) => ({
      tStart: s.tStart,
      tEnd: s.tEnd,
      speaker: s.speaker,
      text: s.text,
    })),
    summary: model.summary,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

// --- Markdown / Obsidian -------------------------------------------------------

/** The date used in frontmatter: prefer startedAt, else createdAt (YYYY-MM-DD). */
function frontmatterDate(model: ExportModel): string {
  const iso = model.meeting.startedAt ?? model.meeting.createdAt;
  // Take the date portion of the ISO string deterministically (no timezone math).
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : iso;
}

/** Quote a YAML scalar safely (always double-quoted, escapes embedded quotes). */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A YAML list of scalars, inline (`[a, b]`) — empty list renders as `[]`. */
function yamlList(items: string[]): string {
  if (items.length === 0) return "[]";
  return `[${items.map(yamlScalar).join(", ")}]`;
}

/** Build the Obsidian-compatible YAML frontmatter block (incl. delimiters). */
function frontmatter(model: ExportModel): string {
  const lines = [
    "---",
    `title: ${yamlScalar(model.meeting.title || "Untitled meeting")}`,
    `date: ${frontmatterDate(model)}`,
    `attendees: ${yamlList(model.speakers)}`,
    `speakers: ${yamlList(model.speakers)}`,
    `tags: ${yamlList(["loqui", `kind/${model.meeting.kind}`])}`,
    `source: loqui`,
    `kind: ${yamlScalar(model.meeting.kind)}`,
    `platform: ${yamlScalar(model.meeting.platform ?? "")}`,
    "---",
  ];
  return lines.join("\n");
}

/** Render the summary as a Markdown section list, or "" when no summary. */
function summarySectionMd(model: ExportModel): string {
  const s = model.summary;
  if (!s) return "";
  const parts: string[] = ["## Summary", ""];
  if (s.tldr.trim() !== "") {
    parts.push("### TL;DR", "", s.tldr.trim(), "");
  }
  if (s.decisions.length > 0) {
    parts.push("### Decisions", "");
    for (const d of s.decisions) parts.push(`- ${d}`);
    parts.push("");
  }
  if (s.actionItems.length > 0) {
    parts.push("### Action items", "");
    for (const a of s.actionItems) {
      parts.push(a.owner ? `- [ ] ${a.text} (@${a.owner})` : `- [ ] ${a.text}`);
    }
    parts.push("");
  }
  if (s.topics.length > 0) {
    parts.push("### Topics", "");
    for (const t of s.topics) parts.push(`- ${t}`);
    parts.push("");
  }
  return parts.join("\n");
}

/** Render the transcript as a Markdown section: `**Speaker** [hh:mm:ss]: text`. */
function transcriptSectionMd(model: ExportModel): string {
  const lines: string[] = ["## Transcript", ""];
  for (const seg of model.segments) {
    const ts = formatVttTimestamp(seg.tStart).split(".")[0]!; // hh:mm:ss
    lines.push(`**${seg.speaker}** [${ts}]: ${seg.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Render the model as Obsidian-vault-compatible Markdown with YAML frontmatter
 * (title/date/attendees/speakers/tags/source/kind), a summary section, and a
 * transcript section. This is the default `md` export; {@link toObsidian} is a
 * thin alias kept distinct so the format selector + UI can name it explicitly.
 */
export function toMarkdown(model: ExportModel): string {
  const blocks = [
    frontmatter(model),
    "",
    `# ${model.meeting.title || "Untitled meeting"}`,
    "",
  ];
  const summary = summarySectionMd(model);
  if (summary !== "") {
    blocks.push(summary);
  }
  blocks.push(transcriptSectionMd(model));
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * The "Obsidian note" export shape: same Obsidian-compatible frontmatter +
 * sectioned body as {@link toMarkdown}. Kept as a separate named export so the
 * format enum + UI can offer "Obsidian note" explicitly (and so the shape can
 * diverge later — e.g. wikilinks — without touching the plain `md` path).
 */
export function toObsidian(model: ExportModel): string {
  return toMarkdown(model);
}
