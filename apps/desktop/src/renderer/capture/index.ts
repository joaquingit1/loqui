/**
 * @file Renderer-side dual-stream capture (PRD-1) public surface.
 *
 * Re-exports the capture controller, the React hook, and the device helper so
 * the Capture* components (and, once wired, the App) import from one place.
 */
export {
  createCaptureController,
  CAPTURE_PROCESSOR_NAME,
  type CaptureController,
  type CaptureControllerDeps,
  type CaptureEnv,
  type CaptureStatus,
  type CaptureSourceState,
  type CaptureStatusListener,
} from "./controller.js";
export {
  useCapture,
  type UseCaptureOptions,
  type UseCaptureResult,
} from "./useCapture.js";
export { listAudioInputs, type AudioInputDevice } from "./devices.js";
