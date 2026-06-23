/**
 * @file Main-process transcript persistence (PRD-3) public surface.
 *
 * Re-exports the append-only TranscriptWriter, the final-segment consumer that
 * feeds it + the FTS index, and the MeetingController lifecycle interface so
 * main wiring, the lifecycle build unit, and tests import from one place.
 */
export {
  createTranscriptWriter,
  type TranscriptWriter,
  type TranscriptWriterOptions,
  type TranscriptWriterFs,
} from "./writer.js";
export {
  consumeFinalTranscriptSegments,
  persistFinalSegment,
  type FinalSegmentConsumerDeps,
  type TranscriptIndexStore,
} from "./consumer.js";
export {
  createMeetingController,
  type MeetingController,
  type MeetingControllerOptions,
  type MeetingLifecycleStore,
  type MeetingLifecycleSupervisor,
} from "./controller.js";
