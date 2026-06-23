# PRD-2 — Real-Time Transcription Engine

## Goal
Two parallel faster-whisper pipelines (one per stream) that consume 16 kHz mono PCM and emit **partial** and **confirmed** transcript segments with timestamps, low enough latency for live meeting notes, on CPU-only laptops.

## Background
faster-whisper (CTranslate2) is batch-oriented; real-time use needs a streaming wrapper. We use **Silero VAD** for endpointing and the **LocalAgreement-2** policy (à la `whisper_streaming`) to stabilize incremental output. The mic and system streams run as two independent pipelines and are never mixed.

## Scope / deliverables

### Engine (`sidecar/loqui_sidecar/transcription/`)
- faster-whisper via CTranslate2; configurable `model_size` (default tuned for CPU, e.g. `small`/`distil` family), `device` (`cpu`/`cuda`/`auto`), `compute_type` (`int8` default on CPU, `float16` on GPU).
- **Silero VAD** gating: only feed speechful audio; segment on silence.
- **LocalAgreement-2** streaming wrapper: buffer with overlap, emit a segment as `final` once two consecutive decodes agree on its prefix; emit interim text as `partial`.
- One pipeline instance per `source` (`mic`, `system`), running concurrently (threads/async); bounded queues with documented backpressure.

### Model management
- Auto-download the selected model on first use with **progress events** to the UI; cache under `~/Loqui/models/`. Offline-friendly once cached.
- Surface model load/availability in `/health`.

### Events
- Emit `TranscriptSegment` events (PRD-0 contract) to main → renderer: `partial` updates in place, `final` commits. Include `tStart`/`tEnd` relative to meeting start and a stable `segId`.

### Config & performance
- Settings: model size, language (or auto), `compute_type`, VAD aggressiveness, max parallelism.
- Document measured CPU/RAM and latency for the default model on Apple Silicon and a typical Windows CPU; provide a "lite" preset for weak machines.

## Out of scope
Persisting the transcript file / library (PRD-3). Diarization (PRD-5). Speaker names (PRD-6).

## Acceptance criteria
1. Speaking into the mic produces live `partial` text that stabilizes into `final` segments within a few seconds; system-audio speech does the same on its own pipeline.
2. `mic` and `system` transcripts remain entirely separate (correct `source` on every segment).
3. Both pipelines run simultaneously without starving each other; sustained load is acceptable on an M-series laptop with the default model (document the numbers).
4. First run downloads the model with visible progress; subsequent runs work offline.
5. Unit tests: VAD segmentation on a fixture WAV; LocalAgreement emits stable finals on a fixture; no duplicate/overlapping `final` segIds.

## Notes for implementers
- Reference architectures: `ufal/whisper_streaming` (LocalAgreement), `collabora/WhisperLive`, `KoljaB/RealtimeSTT`.
- Keep the streaming policy isolated and unit-testable (pure function over a decode sequence) — it's the trickiest correctness surface.
- CTranslate2 has no Metal/MPS GPU path; on Apple Silicon use CPU + `int8`.
