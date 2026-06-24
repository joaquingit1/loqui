/**
 * TranscriptWriter — the ONE and ONLY module in the app that writes the
 * per-meeting transcript files: the human-facing
 * `<dataRoot>/meetings/<id>/transcript.live.md` (PRD-3) AND the parallel
 * structured `<dataRoot>/meetings/<id>/transcript.jsonl` (PRD-5: one JSON
 * record per confirmed segment, read by diarization alignment). Both are fed by
 * the SAME confirmed-segment stream and stay APPEND-ONLY — this remains the only
 * transcript writer and is NOT an AI write.
 *
 * Import as:
 *   `import { createTranscriptWriter, type TranscriptWriter } from "../transcript/writer.js"`
 *
 * Ownership invariant (structural enforcement of the cross-cutting
 * "AI never edits the transcript" rule): the public surface is APPEND-ONLY.
 * There is intentionally NO update/replace/delete/truncate method. The file is
 * fed exclusively by the forwarded `final` TranscriptSegment stream (mic="You",
 * system="They"); partials are NEVER written. Any future AI/chat/summary code
 * MUST go through the read-only store `getTranscript` reader, never this writer.
 *
 * Crash-safety / flush cadence: each confirmed segment is appended with a
 * single `appendFileSync` (O_APPEND — atomic per write on POSIX & Windows for
 * the small one-line payloads we write) followed by an `fsyncSync` of the fd, so
 * a confirmed line is durable on disk before the call returns. This bounds data
 * loss on crash to at most an in-flight (not-yet-confirmed) segment and keeps
 * the file append-only: it is only ever extended, never rewritten. A failed
 * append is swallowed after logging — a disk error must not break the live WS /
 * supervision loop the segments ride in on.
 *
 * Dedupe: a `final` may be redelivered (reconnect / replay). The writer keeps an
 * in-memory set of already-written `segId`s per meeting and skips repeats, so
 * the file never gets a duplicate line for the same confirmed segment. (The FTS
 * index has its own durable dedupe ledger; this in-memory set covers the file.)
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import {
  formatStructuredTranscriptLine,
  formatTranscriptLine,
  type TranscriptSegment,
} from "@loqui/shared";
import { meetingLiveTranscriptPath, meetingTranscriptPath } from "../store/paths.js";

/**
 * The append-only writer surface. Deliberately minimal: one method that appends
 * a confirmed segment. No other mutation is exposed.
 */
export interface TranscriptWriter {
  /**
   * Append ONE confirmed (`final`) segment to its meeting's transcript.live.md
   * and fsync it. A non-`final` segment is ignored (defense-in-depth — callers
   * should pre-filter). A repeat of an already-written `segId` for the same
   * meeting is a no-op. Returns true if a line was written, false if skipped.
   * Never throws.
   */
  appendConfirmedSegment(segment: TranscriptSegment): boolean;
}

/** Injectable fs seam so the writer is unit-testable without a real disk. */
export interface TranscriptWriterFs {
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  appendFileSync: typeof appendFileSync;
  fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync;
}

const realFs: TranscriptWriterFs = {
  mkdirSync,
  openSync,
  appendFileSync,
  fsyncSync,
  closeSync,
};

export interface TranscriptWriterOptions {
  /** Resolve the transcript.live.md path for a meeting id. Defaults to the store path. */
  resolvePath?: (meetingId: string) => string;
  /**
   * Resolve the structured transcript.jsonl path for a meeting id (PRD-5).
   * Defaults to the store path for the `"structured"` variant. The same
   * confirmed segment is appended here as one JSON record (per
   * {@link formatStructuredTranscriptLine}) alongside the `.md` line.
   */
  resolveStructuredPath?: (meetingId: string) => string;
  /** Injectable fs (tests). Defaults to node:fs. */
  fs?: TranscriptWriterFs;
}

/** Construct an append-only {@link TranscriptWriter}. */
export function createTranscriptWriter(
  options: TranscriptWriterOptions = {},
): TranscriptWriter {
  const resolvePath = options.resolvePath ?? meetingLiveTranscriptPath;
  const resolveStructuredPath =
    options.resolveStructuredPath ?? ((id: string) => meetingTranscriptPath(id, "structured"));
  const fs = options.fs ?? realFs;
  // meetingId -> set of segIds already written to the file.
  const written = new Map<string, Set<string>>();

  /** Append one line to a file (O_APPEND + fsync); returns false + logs on error. */
  function appendDurable(target: string, line: string): boolean {
    try {
      fs.mkdirSync(dirname(target), { recursive: true });
      // Append the line (O_APPEND), then fsync so the confirmed line is durable
      // before we return. Open/append/fsync/close keeps it simple and
      // crash-safe; we never hold the file open across calls.
      const fd = fs.openSync(target, "a");
      try {
        fs.appendFileSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      // A disk error must not break the WS/supervision loop. Log and drop. The
      // next confirmed segment for this meeting will retry the file.
      console.error("[loqui] transcript append failed:", err);
      return false;
    }
  }

  return {
    appendConfirmedSegment(segment: TranscriptSegment): boolean {
      if (segment.status !== "final") return false;

      let seen = written.get(segment.meetingId);
      if (!seen) {
        seen = new Set<string>();
        written.set(segment.meetingId, seen);
      }
      if (seen.has(segment.segId)) return false;

      // Append the human-facing `.md` line first (the artifact the user
      // watches), then the structured `.jsonl` record (PRD-5 alignment input).
      // Both are guarded; the `.md` write decides success/dedupe so a failed
      // `.jsonl` append never blocks the live transcript. The dedupe set is the
      // single per-segId gate for BOTH files, keeping them 1:1.
      const mdOk = appendDurable(resolvePath(segment.meetingId), formatTranscriptLine(segment));
      if (!mdOk) return false;
      appendDurable(
        resolveStructuredPath(segment.meetingId),
        formatStructuredTranscriptLine(segment),
      );
      seen.add(segment.segId);
      return true;
    },
  };
}
