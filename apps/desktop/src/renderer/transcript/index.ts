/**
 * @file Renderer-side live transcript (PRD-2) public surface.
 *
 * Re-exports the pure transcript model + the React hook so the LiveTranscript
 * component (and tests) import from one place.
 */
export {
  applySegment,
  applySegments,
  emptyTranscriptState,
  mergedSegments,
  SOURCE_LABEL,
  TRANSCRIPT_SOURCES,
  type StreamState,
  type TranscriptState,
} from "./model.js";
export {
  useLiveTranscript,
  type UseLiveTranscriptOptions,
  type UseLiveTranscriptResult,
} from "./useLiveTranscript.js";
