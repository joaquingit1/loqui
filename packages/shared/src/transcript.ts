/**
 * PRD-3 shared transcript contract: the `transcript.live.md` line format and
 * the variant enum, defined ONCE so the main-process TranscriptWriter (producer)
 * and any reader/renderer agree on a single canonical format.
 *
 * `transcript.live.md` is an append-only, human-facing Markdown file. Each
 * confirmed (`final`) segment is one timestamped, source-attributed line:
 *
 *     [00:00:04] You said: Hey, can you hear me?
 *     [00:00:07] They said: Yep, loud and clear.
 *
 * - `[hh:mm:ss]` is `tStart` (seconds from meeting start) formatted via
 *   {@link formatTranscriptTimestamp}.
 * - `mic` -> "You said:", `system` -> "They said:" (see {@link SPEAKER_LABEL}).
 * - The line ends with a single `\n`. Text is single-lined (newlines collapsed
 *   to spaces) so one segment is always exactly one line — keeping the file
 *   append-only and trivially round-trippable.
 */
import type { AudioSource } from "./audio.js";
import { TRANSCRIPT_VARIANTS } from "./constants.js";
import type { TranscriptSegment } from "./events.js";

/** The transcript variant a reader can request. */
export type TranscriptVariant = (typeof TRANSCRIPT_VARIANTS)[number];

/**
 * Speaker label written into `transcript.live.md` for each source.
 * mic = the local user ("You"); system = the remote/loopback side ("They").
 */
export const SPEAKER_LABEL: Record<AudioSource, string> = {
  mic: "You",
  system: "They",
};

/**
 * Format a seconds-from-start offset as a zero-padded `hh:mm:ss` clock for the
 * `[..]` prefix. Negative/NaN values clamp to 0; hours grow past two digits for
 * long meetings (e.g. `100:00:00`).
 */
export function formatTranscriptTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Render ONE confirmed segment as its `transcript.live.md` line, terminated by
 * a single `\n`. Pure: the TranscriptWriter calls this and appends the result.
 * The segment's `status` is NOT checked here (the writer only ever passes
 * `final` segments) so this helper stays usable for tests/round-trip checks.
 *
 * Embedded newlines/carriage-returns in `text` are collapsed to single spaces
 * so the one-segment-per-line invariant holds regardless of ASR output.
 */
export function formatTranscriptLine(segment: TranscriptSegment): string {
  const ts = formatTranscriptTimestamp(segment.tStart);
  const who = SPEAKER_LABEL[segment.source];
  const text = segment.text.replace(/[\r\n]+/g, " ").trimEnd();
  return `[${ts}] ${who} said: ${text}\n`;
}
