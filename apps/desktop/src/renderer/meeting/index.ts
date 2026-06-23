/**
 * @file Renderer-side meeting lifecycle + live view (PRD-3) public surface.
 *
 * Re-exports the pure lifecycle model, the controller hook, and the elapsed
 * ticker so the MeetingControls / RecordingStatus components (and tests) import
 * from one place.
 */
export {
  applyStatusEvent,
  canStart,
  canStop,
  initialMeetingState,
  isRecordingPhase,
  phaseFromStatus,
  type MeetingControllerState,
  type MeetingPhase,
} from "./model.js";
export {
  useMeetingController,
  type MeetingCaptureControl,
  type MeetingLifecycleApi,
  type UseMeetingControllerOptions,
  type UseMeetingControllerResult,
} from "./useMeetingController.js";
export {
  useElapsed,
  formatElapsed,
  type UseElapsedOptions,
} from "./useElapsed.js";
export {
  useMeetingCapture,
  type UseMeetingCaptureOptions,
  type UseMeetingCaptureResult,
} from "./useMeetingCapture.js";
