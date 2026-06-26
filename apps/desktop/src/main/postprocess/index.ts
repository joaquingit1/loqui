/**
 * @file Main-process post-processing (PRD-5) public surface.
 *
 * Re-exports the post-processing pipeline (stop -> postProcess request ->
 * relay -> index + finalize), the IPC + WS bridges (job relay + the read/rename/
 * regenerate/HF-token handlers), the HF-token keystore, and the pure render/
 * index-text + diarized-file writer helpers, so the main wiring + tests import
 * from one place.
 *
 * INVARIANT (re-asserted at the module boundary): NOTHING exported here can write
 * transcript.live.md / transcript.jsonl / meta.json's transcript. The summary is
 * produced by the sidecar (separate derived file); the diarized files are
 * produced by the sidecar and only ever DETERMINISTICALLY rewritten by main on a
 * rename; main's only persistence is the store's meta update + FTS index.
 */
export {
  createPostProcessPipeline,
  type PostProcessPipeline,
  type PostProcessPipelineDeps,
  type PostProcessSupervisor,
  type ProviderKeySource,
} from "./pipeline.js";
export {
  registerPostProcessIpc,
  forwardJobUpdates,
  forwardSummaryTokens,
  type PostProcessIpcDeps,
} from "./register.js";
export { HfKeystore, type SafeStorageLike } from "./hf-keystore.js";
export { renderDiarizedMd, buildIndexText } from "./render.js";
export { writeDiarizedTranscript } from "./writers.js";
