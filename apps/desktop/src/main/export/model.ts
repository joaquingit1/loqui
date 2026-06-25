/**
 * The normalized EXPORT MODEL (PRD-13).
 *
 * A small, format-agnostic projection of a meeting's canonical artifacts that
 * every export format renders from. Building it ONCE (from the readers) and
 * rendering each format from this pure value keeps the format transforms PURE +
 * DETERMINISTIC and means no format duplicates transcript/summary state.
 *
 * Source-of-truth selection (PRD-13): use the DIARIZED transcript when available
 * (richer — per-segment speaker labels), else fall back to the LIVE transcript
 * (parsed from transcript.live.md). Either way the result is a flat list of
 * timed, speaker-attributed segments + the AI summary + the meeting metadata.
 *
 * This module is PURE (no fs / Electron): the service (./service.ts) reads the
 * artifacts via the store and hands them here; tests build a model from fixtures
 * directly. The live-transcript fallback parse lives here too (pure string ->
 * segments) so it is unit-testable without touching disk.
 */
import {
  SPEAKER_LABEL,
  type DiarizedTranscript,
  type Meeting,
  type Summary,
} from "@loqui/shared";

/** One timed, speaker-attributed segment in the normalized export model. */
export interface ExportSegment {
  /** Seconds from meeting start (inclusive). */
  tStart: number;
  /** Seconds from meeting start (exclusive). */
  tEnd: number;
  /** Resolved speaker display name ("You", "Speaker N", or a rename). */
  speaker: string;
  /** The segment text (single-lined). */
  text: string;
}

/** The normalized, format-agnostic export model. */
export interface ExportModel {
  meeting: Meeting;
  /** Ordered speaker display names (first-appearance order). */
  speakers: string[];
  /** Flat, time-ordered segments (diarized when available, else live). */
  segments: ExportSegment[];
  /** The AI summary, or null when none was generated. */
  summary: Summary | null;
  /** True when the diarized transcript backed the model (false = live fallback). */
  usedDiarized: boolean;
}

/**
 * Resolve the display name for a diarized segment: the user's rename
 * (`displayName`) when set, else the stable `speaker` label.
 */
function diarizedSpeakerName(seg: DiarizedTranscript["segments"][number]): string {
  const name = seg.displayName?.trim();
  return name && name !== "" ? name : seg.speaker;
}

/**
 * Build the normalized export model from a meeting's artifacts. Prefers the
 * diarized transcript; falls back to parsing the live transcript markdown when
 * diarization has not produced output. PURE + DETERMINISTIC.
 */
export function buildExportModel(input: {
  meeting: Meeting;
  diarized: DiarizedTranscript | null;
  liveTranscript: string;
  summary: Summary | null;
}): ExportModel {
  const { meeting, diarized, liveTranscript, summary } = input;

  if (diarized && diarized.segments.length > 0) {
    const segments: ExportSegment[] = diarized.segments.map((s) => ({
      tStart: s.tStart,
      tEnd: s.tEnd,
      speaker: diarizedSpeakerName(s),
      text: s.text,
    }));
    const speakers = orderedSpeakers(segments);
    return { meeting, speakers, segments, summary, usedDiarized: true };
  }

  const segments = parseLiveTranscript(liveTranscript);
  const speakers = orderedSpeakers(segments);
  return { meeting, speakers, segments, summary, usedDiarized: false };
}

/** Distinct speaker names in first-appearance order. */
function orderedSpeakers(segments: ExportSegment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of segments) {
    if (s.speaker !== "" && !seen.has(s.speaker)) {
      seen.add(s.speaker);
      out.push(s.speaker);
    }
  }
  return out;
}

/**
 * One transcript.live.md line:  `[hh:mm:ss] You said: <text>`. Captures the
 * timestamp, the speaker word ("You"/"They"), and the text. Tolerant of extra
 * spaces; any line that does not match is skipped (blank lines / headings).
 */
const LIVE_LINE_RE = /^\[(\d{1,}):(\d{2}):(\d{2})\]\s+(You|They)\s+said:\s?(.*)$/;

/** The two live-transcript speaker words map back to the canonical labels. */
const LIVE_WORD_TO_SOURCE: Record<string, keyof typeof SPEAKER_LABEL> = {
  You: "mic",
  They: "system",
};

/**
 * Parse the human-facing `transcript.live.md` into timed segments. The live
 * format is one segment per line: `[hh:mm:ss] You said: <text>` (see
 * @loqui/shared transcript.ts). Each line's `[hh:mm:ss]` is the segment start;
 * the end is the NEXT segment's start (or start+0 for the last line). PURE.
 */
export function parseLiveTranscript(md: string): ExportSegment[] {
  const out: ExportSegment[] = [];
  for (const rawLine of md.split(/\r?\n/)) {
    const m = LIVE_LINE_RE.exec(rawLine);
    if (!m) continue;
    const [, hh, mm, ss, who, text] = m;
    const tStart = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
    const source = LIVE_WORD_TO_SOURCE[who!]!;
    out.push({
      tStart,
      tEnd: tStart, // refined below to the next segment's start
      speaker: SPEAKER_LABEL[source],
      text: (text ?? "").trim(),
    });
  }
  // Refine each segment's end to the next segment's start so SRT/VTT cues have a
  // non-degenerate duration when the live transcript carries only start times.
  for (let i = 0; i < out.length; i += 1) {
    const next = out[i + 1];
    out[i]!.tEnd = next ? Math.max(out[i]!.tStart, next.tStart) : out[i]!.tStart + 2;
  }
  return out;
}
