# PRD-5 — Post-Meeting Diarization + AI Summaries

## Goal
After a meeting ends, split the **system ("They")** audio into speakers with pyannote.audio, align those turns to the existing transcript, write a speaker-labeled transcript, and generate an **AI summary** of the meeting via the PRD-4 provider layer. Every meeting ends up diarized, dated, and summarized.

## Background
Diarization is **offline/post-processing** (not real-time) and runs only on `system.wav` — the mic stream is already known to be the local user ("You"). Sortformer is excluded (needs NVIDIA GPU); pyannote.audio 3.1 is MIT and CPU-capable.

## Scope / deliverables

### Diarization worker (`sidecar/loqui_sidecar/diarization/`)
- Run pyannote.audio 3.1 speaker-diarization on `~/Loqui/meetings/<id>/audio/system.wav` as a background **job** (PRD-0 `JobUpdate` events with progress).
- **HF token UX**: pyannote weights are gated. Settings flow to enter a Hugging Face token (stored in keychain), with a link to accept model terms. Token used at runtime, **never bundled**.
- **torch/pyannote are heavy**: install lazily / download-on-first-diarization to keep the base install lean. Degrade gracefully if unavailable (meeting still saved, diarization marked skipped).

### Alignment
- Assign diarized speaker turns to existing transcript segments by **timestamp overlap** (whisperX-style). Output `~/Loqui/meetings/<id>/transcript.diarized.json` and `.md` with `Speaker 1 / Speaker 2 / …` labels (mic segments labeled "You").
- Idempotent: re-running diarization replaces prior output cleanly.
- Speakers are **renameable** in the UI; renames persist and propagate to the diarized files + index.

### Summaries
- On meeting completion (after diarization when available), generate `summary.md` via the **PRD-4 provider** (read-only over the transcript): TL;DR, key decisions, action items (with owners when inferable), topics. Regenerate on demand.
- Index the summary into FTS for search; show it in the meeting view and library.

### Pipeline wiring
- `stop` → finalize WAVs → enqueue diarization → on completion enqueue summary → update `Meeting.status`. Robust to partial failure at each step.

## Out of scope
Real-name resolution (PRD-6 maps `Speaker N` → names). Real-time diarization.

## Acceptance criteria
1. A finished meeting auto-produces `transcript.diarized.{json,md}` distinguishing **≥2 remote speakers** plus "You", and a coherent `summary.md`, both saved and searchable.
2. Re-running diarization is idempotent (no duplicated/garbled output).
3. Renaming a speaker updates the diarized transcript and index.
4. With no HF token / torch unavailable, the meeting still completes with the live transcript + summary; diarization is clearly marked skipped (no crash).
5. The summary is generated through the same provider layer as PRD-4 (no separate AI path) and never mutates the transcript.
6. Tests: alignment assigns speakers correctly on a fixture with known turns; summary job reuses the provider interface; idempotency test.

## Notes for implementers
- Alignment quality hinges on consistent timestamps between PRD-2 segments and pyannote turns — keep both relative to meeting start.
- Long meetings: diarization on CPU can take minutes; keep it a background job with progress and never block the UI.
