/**
 * @loqui/audio — dual-stream capture DSP + binary frame codec (PRD-1).
 *
 * Everything exported here except the AudioWorklet shell is a PURE function
 * (no browser/Node globals) so the whole pipeline is hermetically unit-tested
 * with synthetic Float32/Int16 buffers. The mic and system streams are kept
 * INDEPENDENT end-to-end: nothing in this package shares or mixes buffers
 * across sources.
 *
 * Pipeline per source: downmixToMono -> resampleTo16k -> floatToPcm16 ->
 * encodeFrame -> (IPC) -> sidecar.
 */

// Re-export the shared audio contract so consumers have one import surface.
export type { AudioSource } from "@loqui/shared";
export { AUDIO_FRAME_SAMPLES, AUDIO_SAMPLE_RATE, AUDIO_CHANNELS } from "@loqui/shared";

export { downmixToMono } from "./downmix.js";
export { resampleTo16k, resample, StreamingResampler } from "./resample.js";
export { floatToPcm16, pcm16ToFloat } from "./pcm.js";
export {
  encodeFrame,
  decodeFrame,
  AUDIO_FRAME_HEADER_BYTES,
  type DecodedFrame,
} from "./frame-codec.js";
export {
  CaptureProcessor,
  CAPTURE_PROCESSOR_NAME,
  type CaptureProcessorOptions,
} from "./capture-worklet.js";
