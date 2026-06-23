/**
 * @file Main-process transcript forwarding (PRD-2) public surface.
 *
 * Re-exports the supervisor → renderer transcript forwarder so main wiring and
 * tests import from one place.
 */
export {
  forwardTranscriptSegments,
  pushTranscriptSegmentsToWindow,
  parseTranscriptSegment,
  windowSink,
  type TranscriptSupervisor,
  type TranscriptSegmentSink,
} from "./forward.js";
