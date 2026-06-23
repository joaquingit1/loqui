/**
 * AudioWorklet module entry (PRD-1).
 *
 * This file is NOT imported into the renderer's main bundle — it is loaded into
 * an `AudioWorkletGlobalScope` at runtime via `audioWorklet.addModule(url)`
 * (see ./controller.ts). Its ONLY job is to pull in `@loqui/audio`'s capture
 * processor, whose top-level `registerProcessor("loqui-capture", …)` call runs
 * in the worklet scope and makes the node available to
 * `new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, …)`.
 *
 * The capture DSP (downmix → resample → pcm_s16le → encode binary frame) lives
 * entirely in @loqui/audio so it is unit-tested with synthetic PCM under Node;
 * this shim keeps that single source of truth and adds no logic.
 *
 * NOTE (build wiring): @loqui/audio must be a dependency of @loqui/desktop for
 * this import to resolve. See the unit summary's "missing dependency" note.
 */
import "@loqui/audio/dist/capture-worklet.js";
