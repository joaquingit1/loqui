/**
 * Live-transcript model (PRD-2, renderer side) — a pure, framework-agnostic
 * reducer over the incoming {@link TranscriptSegment} stream.
 *
 * The sidecar emits a sequence of segments per (meeting, source): `partial`
 * segments that update IN PLACE keyed by `segId`, superseded by a later `final`
 * with the same `segId`. The mic ("You") and system ("They") streams are
 * INDEPENDENT — they are kept in separate ordered lists and never merged; the
 * only thing that routes a segment to a stream is {@link TranscriptSegment.source}.
 *
 * Ordering is by first-seen arrival per stream, which preserves the sidecar's
 * emission order for that source. A `final` replaces the `partial` it shares a
 * `segId` with in place (keeping its slot), so committed text doesn't jump
 * around. A `final` is terminal: a later segment with the same `segId` (which
 * the streaming policy must not emit) is ignored so committed output is never
 * retracted.
 *
 * This is deliberately React-free so it can be unit-tested directly and reused
 * by the LiveTranscript component via a thin hook.
 */
import type { AudioSource, TranscriptSegment } from "@loqui/shared";

/** The two transcript streams. mic = "You", system = "They". */
export const TRANSCRIPT_SOURCES: readonly AudioSource[] = ["mic", "system"] as const;

/** Human-facing label for each stream. */
export const SOURCE_LABEL: Record<AudioSource, string> = {
  mic: "You",
  system: "They",
};

/** One stream's ordered segments (first-seen order). */
export type StreamState = TranscriptSegment[];

/** The full live-transcript state: one independent ordered list per source. */
export type TranscriptState = Record<AudioSource, StreamState>;

/** A fresh, empty transcript state (both streams empty). */
export function emptyTranscriptState(): TranscriptState {
  return { mic: [], system: [] };
}

/**
 * Apply one incoming segment to the state, returning a NEW state (immutable —
 * safe for React `useState`/`useReducer` identity checks). Only the affected
 * source's list is rebuilt; the other source's list is returned by reference
 * unchanged, so the two streams render independently.
 *
 * Rules:
 *  - new `segId`            → appended to that source's list (preserves order),
 *  - existing `segId`, prior was `partial` → replaced IN PLACE (same slot),
 *  - existing `segId`, prior was `final`   → ignored (finals never retracted).
 */
export function applySegment(
  state: TranscriptState,
  segment: TranscriptSegment,
): TranscriptState {
  const { source } = segment;
  const stream = state[source];
  const idx = stream.findIndex((s) => s.segId === segment.segId);

  let nextStream: StreamState;
  if (idx === -1) {
    nextStream = [...stream, segment];
  } else if (stream[idx]!.status === "final") {
    // A committed segment is terminal — never retract or rewrite it.
    return state;
  } else {
    nextStream = stream.slice();
    nextStream[idx] = segment;
  }

  return { ...state, [source]: nextStream };
}

/** Apply many segments in arrival order (left-to-right). */
export function applySegments(
  state: TranscriptState,
  segments: Iterable<TranscriptSegment>,
): TranscriptState {
  let next = state;
  for (const segment of segments) next = applySegment(next, segment);
  return next;
}
