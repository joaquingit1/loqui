# PRD-12 — File Import Transcription + Voice Memo Mode

## Goal
Let users **transcribe an existing audio/video file** (and diarize + summarize it like a meeting), and add a lightweight **mic-only Voice Memo** capture mode — matching a comparable local app's "Transcribe File" and "Voice Memo" features.

## Background (competitive)
a comparable local app offers "Transcribe File" (drop an m4a/mp4/mov/mp3/wav → transcript) and a mic-only "Voice Memo" mode (separate storage). Loqui is meeting-recording-only. Both are natural extensions of the existing pipeline (decode → 16 kHz mono PCM → the PRD-2 transcription engine → PRD-3 store → PRD-5 diarization/summary).

## Scope / deliverables
- **File import**: a "Transcribe a file" action accepting common audio/video (m4a, mp3, wav, mp4, mov, m4v, …). Decode + resample to 16 kHz mono (ffmpeg/PyAV in the sidecar), run the chosen transcription engine (PRD-9), create a meeting record (kind `"import"`) with the produced transcript, then run diarization + summary (PRD-5) on it. Progress via the existing JobUpdate events. Single-stream source (no separate You/They) → diarize all speakers as Speaker 1/2/…
- **Voice Memo mode**: mic-only capture (no system audio) producing a meeting record of kind `"voice-memo"`; transcribed live like a meeting; optionally summarized. Shown distinctly in the library (its own type/icon, matching PRD-3's dated list).
- Both flow through the existing meeting store, library, search, diarization, and summary — they are just meetings with a `kind` discriminator. Export (PRD-13) applies.

## Out of scope
New transcription engines (PRD-9). The library/search UI already exists (PRD-3) — extend it to show the new kinds.

## Acceptance criteria
1. Importing an audio/video file produces a meeting with a correct transcript, is diarized + summarized, and appears in the dated library + full-text search.
2. Voice Memo records mic-only, transcribes (live), is stored as its own kind, and is searchable.
3. Both reuse the PRD-2/3/5 pipeline (no forked transcript model); JobUpdate progress is shown.
4. Hermetic tests: file decode→PCM→transcription (fake ASR) produces a transcript record; voice-memo lifecycle (mic-only) creates the right kind; library/search include the new kinds. A new `smoke:import` drives a synthetic WAV file end-to-end (decode→transcript→store→search).
5. PRD-0..11 stay green.

## Notes for implementers
- Decode with PyAV/ffmpeg in the sidecar (faster-whisper already pulls PyAV). Reuse the audio-ingest 16 kHz mono path so the engine sees the same format as live capture.
- `kind: "meeting" | "import" | "voice-memo"` is an additive field on the Meeting model (defaulted to `"meeting"`); the store/library/search treat them uniformly.
