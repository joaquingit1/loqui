/**
 * Final-segment consumer (PRD-3): the main-side seam that turns the forwarded
 * `final` TranscriptSegment stream into durable transcript state.
 *
 * The supervisor fans out every sidecar WS notification; PRD-2's
 * `forwardTranscriptSegments` already validates + forwards `transcriptSegment`
 * events to the renderer. This module subscribes to that SAME fan-out, filters
 * to `final` segments, and routes each one to:
 *   1. the {@link TranscriptWriter} (appends one line to transcript.live.md), and
 *   2. the store FTS transcript index (idempotent per meeting+segId).
 *
 * Partials are ignored: only confirmed text is persisted/indexed. The consumer
 * is the SOLE feeder of the TranscriptWriter — nothing else calls
 * `appendConfirmedSegment` in production.
 */
import type { TranscriptSegment } from "@loqui/shared";
import {
  forwardTranscriptSegments,
  type TranscriptSupervisor,
} from "../transcription/forward.js";
import type { TranscriptWriter } from "./writer.js";

/** The store slice the consumer needs (kept minimal for tests). */
export type TranscriptIndexStore = {
  appendTranscriptSegment(meetingId: string, segId: string, text: string): void;
};

export interface FinalSegmentConsumerDeps {
  supervisor: TranscriptSupervisor;
  writer: TranscriptWriter;
  store: TranscriptIndexStore;
}

/**
 * Persist + index each confirmed segment. Append to transcript.live.md first
 * (the human-facing artifact the user watches), then index into FTS. A throwing
 * index call must not prevent the file append from having happened; both are
 * individually guarded so neither can break the WS fan-out loop.
 */
export function persistFinalSegment(
  segment: TranscriptSegment,
  writer: TranscriptWriter,
  store: TranscriptIndexStore,
): void {
  if (segment.status !== "final") return;
  writer.appendConfirmedSegment(segment);
  try {
    store.appendTranscriptSegment(segment.meetingId, segment.segId, segment.text);
  } catch (err) {
    console.error("[loqui] transcript index append failed:", err);
  }
}

/**
 * Subscribe to the supervisor's transcript notifications and feed every
 * confirmed (`final`) segment to the writer + index. Reuses PRD-2's
 * `forwardTranscriptSegments` (same validate/drop-malformed semantics) so there
 * is no second wire. Returns an unsubscribe fn.
 */
export function consumeFinalTranscriptSegments(
  deps: FinalSegmentConsumerDeps,
): () => void {
  const { supervisor, writer, store } = deps;
  return forwardTranscriptSegments(supervisor, (segment) => {
    persistFinalSegment(segment, writer, store);
  });
}
