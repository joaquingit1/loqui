/**
 * Pure render + index-text helpers for the diarized transcript (PRD-5).
 *
 * These mirror the sidecar's `render_diarized_md` / index-text concatenation so
 * that a main-driven rewrite (a speaker rename) reproduces the SAME
 * `transcript.diarized.md` the sidecar first wrote — byte-for-byte for the same
 * inputs — and indexes the SAME searchable text. Both functions are PURE (no
 * I/O), so they are exhaustively unit-testable and reusable.
 *
 * INVARIANT: these touch ONLY the derived diarized transcript. They never read
 * or write transcript.live.md / transcript.jsonl / meta.json.
 */
import type { DiarizedSegment, DiarizedTranscript, Summary } from "@loqui/shared";

/** The name to show for a segment: the rename if present, else the stable label. */
function speakerDisplay(seg: DiarizedSegment): string {
  return seg.displayName && seg.displayName.trim() !== "" ? seg.displayName : seg.speaker;
}

/** Zero-padded `hh:mm:ss` for a non-negative seconds-from-start value. */
function formatTimestamp(tStartSeconds: number): string {
  const total = tStartSeconds && tStartSeconds > 0 ? Math.floor(tStartSeconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Render a {@link DiarizedTranscript} to its human-facing Markdown — one line
 * per segment: `[hh:mm:ss] <speaker>: <text>`, where `<speaker>` is the rename
 * (`displayName`) when set, else the stable label. Matches the sidecar's
 * `render_diarized_md`: CR/LF in text collapse to spaces, the line is
 * right-trimmed, and the document ends with a trailing newline (or is empty when
 * there are no segments). PURE — no I/O.
 */
export function renderDiarizedMd(diarized: DiarizedTranscript): string {
  const lines: string[] = [];
  for (const seg of diarized.segments) {
    const ts = formatTimestamp(seg.tStart);
    const who = speakerDisplay(seg);
    const text = seg.text.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+$/, "");
    lines.push(`[${ts}] ${who}: ${text}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * The searchable text MAIN should fold into the FTS `summary` column for a
 * diarized transcript + summary: the diarized segment text (display name +
 * spoken text per line) plus the summary's tldr/decisions/action-items/topics.
 * Mirrors the index payload the sidecar puts in `postProcessDone.indexText`, so
 * a main-driven re-index (after a rename) reproduces the same searchable text.
 * PURE — no I/O.
 */
export function buildIndexText(
  diarized: DiarizedTranscript | null,
  summary: Summary | null,
): string {
  const parts: string[] = [];
  if (diarized) {
    for (const seg of diarized.segments) {
      const who = speakerDisplay(seg);
      const text = seg.text.trim();
      if (text !== "") parts.push(`${who}: ${text}`);
    }
  }
  if (summary) {
    if (summary.tldr.trim() !== "") parts.push(summary.tldr.trim());
    for (const d of summary.decisions) if (d.trim() !== "") parts.push(d.trim());
    for (const a of summary.actionItems) {
      const t = a.text.trim();
      if (t !== "") parts.push(a.owner && a.owner.trim() !== "" ? `${a.owner}: ${t}` : t);
    }
    for (const t of summary.topics) if (t.trim() !== "") parts.push(t.trim());
  }
  return parts.join(" ");
}
