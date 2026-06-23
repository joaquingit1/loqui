# PRD-6 — Google Meet Speaker-Name Attribution (Browser Extension)

## Goal
When a meeting is on **Google Meet**, replace generic `Speaker N` labels with **real participant names** by reading Meet's UI and correlating active-speaker timing with the diarized turns.

## Background
This is the **highest-risk, most fragile** feature: it depends on Google Meet's DOM, which changes without notice. It is built after the robust core (capture/transcribe/diarize/summary/MCP) and **must degrade gracefully** — if anything breaks, Loqui still produces generic-labeled diarization.

## Scope / deliverables

### Browser extension (`apps/extension`, MV3)
- Content script on `meet.google.com` that reads:
  - the **participant list** (names), and
  - the **active-speaker indicator** (who's currently talking).
- Emits `{ ts, name, speaking }` events over a **local WebSocket** to the Loqui app (main-process WS server from PRD-0/this PRD), only while a meeting is active.
- Resilient selectors with a documented update process; on selector failure, log + degrade (no crash, no bad data).
- Minimal permissions; no audio, no recording — Loqui captures audio itself.

### App side
- WebSocket server (loopback) accepting extension events; associate the active Meet session with the current Loqui meeting.
- **Correlation engine**: map diarized speaker turns (PRD-5) → names by **timestamp overlap** with active-speaker events (handle gaps, overlaps, and unknown speakers). Confidence-aware; ambiguous turns stay as `Speaker N`.
- Merge resolved names into `transcript.diarized.{json,md}`, the meeting `participants`, and the index. Manual override/rename always wins.

### UX
- Indicator when the extension is connected and names are being captured; clear messaging when it isn't (and that diarization still works).
- One-time extension install/pairing flow.

## Out of scope
Zoom/Teams attribution (future). Reading Meet captions content (we transcribe ourselves). Any cloud/Meet API.

## Acceptance criteria
1. In a live **Google Meet** with 2–3 participants + the extension installed, the finished diarized transcript shows **real names for the majority of turns**.
2. With the extension **absent or broken**, the meeting completes with generic `Speaker N` labels and **no errors** (graceful degradation).
3. Manual speaker renames override auto-resolved names and persist.
4. The WS channel is loopback-only and ignores events when no meeting is active.
5. Tests: correlation engine maps names correctly on a fixture of (diarization turns × active-speaker events), including overlap/gap/unknown cases; selector-failure path degrades cleanly.

## Notes for implementers
- Treat Meet's DOM as untrusted and volatile: isolate selectors behind a small, swappable module with a version note; never let a selector miss break the meeting.
- Correlation is timestamp-based; keep extension event clocks and meeting clock reconciled (account for skew).
