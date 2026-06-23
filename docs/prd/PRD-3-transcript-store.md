# PRD-3 — Live Transcript Store, Meeting Lifecycle & Library

## Goal
Turn the live segment stream into a **real-time-updated transcript file**, persist each meeting with its date and metadata, index it for search, and provide a dated, searchable **library** plus a live transcript view.

## Background
This closes the core vertical slice: capture → transcribe → durable, browsable record. It also establishes the `transcript.live.md` format and the SQLite/FTS index that PRD-5 (summaries) and PRD-7 (MCP) build on.

## Scope / deliverables

### Meeting lifecycle (main + renderer)
- Create → record → stop → processing → done state machine, driving `Meeting.status` and `startedAt`/`endedAt`.
- Start wires up PRD-1 capture + PRD-2 pipelines; stop flushes, finalizes WAVs, and triggers post-processing hooks (diarization/summary come in PRD-5).

### Real-time transcript file
- Append confirmed (`final`) segments to `~/Loqui/meetings/<id>/transcript.live.md` **within ~1s** of confirmation.
- Format: timestamped lines, clearly attributed:
  ```
  [00:00:04] You said: Hey, can you hear me?
  [00:00:07] They said: Yep, loud and clear.
  ```
- Append-only and crash-safe (flush/fsync cadence documented). **Only** the transcription path writes this file (enforces the cross-cutting read-only-for-AI invariant).

### Persistence & index
- Update `meta.json` on lifecycle transitions.
- Insert/Update transcript text into the **FTS5** index (from PRD-0) for full-text search, keyed by meeting + timestamp.

### Library UI (renderer)
- List meetings **sorted by date**, grouped (Today / Yesterday / This week / …), with title, duration, platform, status.
- Full-text **search** across transcripts (via FTS), date filtering, open a meeting to view its transcript.
- Inline **rename** of meeting title.

### Live transcript view (renderer)
- During a meeting, render the two-stream transcript live (partials updating in place, finals committed), auto-scroll with a pause-on-scroll affordance, visually distinguish You vs They.

## Out of scope
Diarization/speaker labels and summaries (PRD-5). AI chat (PRD-4). MCP exposure (PRD-7) — but make the store/index queries reusable by it.

## Acceptance criteria
1. Starting a meeting makes it appear live in the UI; confirmed speech lands in `transcript.live.md` within ~1s.
2. After stop, the meeting shows in the library with correct date, duration, and a readable transcript.
3. The transcript and meeting **survive an app restart** (reloaded from disk + index).
4. A keyword spoken in a past meeting is findable via library search.
5. Renaming a meeting persists to `meta.json` and the index.
6. Tests: file format/round-trip; FTS insert+query; lifecycle state transitions.

## Notes for implementers
- Treat `transcript.live.md` as the human-facing artifact; keep a parallel structured record (segments with timestamps/segIds) if helpful for PRD-5 alignment — but the `.md` is the source the user sees update live.
- Reuse PRD-0 store helpers; do not fork a second meeting model.
