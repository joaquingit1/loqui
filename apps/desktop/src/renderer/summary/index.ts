/**
 * Barrel for the PRD-5 renderer post-processing module: the pure presentation
 * helpers, the job-progress hook, and the HF-token settings component. The
 * Summary / DiarizedTranscript / ProcessingStatus / SpeakerRename components
 * import from here so the public surface of the module is explicit.
 */
export {
  POSTPROCESS_JOB_KINDS,
  JOB_KIND_LABEL,
  JOB_STATE_LABEL,
  isJobTerminal,
  progressPercent,
  reduceJob,
  isProcessing,
  allJobsTerminal,
  isYou,
  speakerDisplay,
  speakerEntries,
  formatTimecode,
  summaryHasContent,
  type JobProgressMap,
  type SpeakerEntry,
} from "./model.js";
export {
  useJobProgress,
  type UseJobProgressOptions,
  type UseJobProgressResult,
} from "./useJobProgress.js";
export { HfTokenSettings, PYANNOTE_TERMS_URL, type HfTokenSettingsProps } from "./HfTokenSettings.js";
