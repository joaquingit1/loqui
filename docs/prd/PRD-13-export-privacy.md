# PRD-13 — Export & Interop + Capture/Privacy Controls

## Goal
Add rich **export formats** (matching a comparable local app's SRT/JSON and exceeding with VTT/PDF/DOCX + Obsidian-style notes) and the **privacy/capture controls** they ship (hidden-from-screen-share, don't-keep-audio, per-app system-audio filtering) — so Loqui is a strict superset on output and privacy.

## Background (competitive)
A comparable local app exports Markdown (Obsidian-frontmatter), SRT, and JSON; is hidden from screen sharing by default; saves transcripts-only (no audio on disk); and filters system audio to the detected conferencing app (ScreenCaptureKit per-process). Loqui persists `transcript.live.md` / diarized JSON+MD / `summary.md` and `mic.wav`/`system.wav`, but has no explicit export action, no screen-share hiding, no audio-retention policy, and captures all system loopback. This PRD closes those and adds PDF/DOCX/VTT to go beyond them.

## Scope / deliverables
### Export & interop
- An **Export** action on any meeting producing: **Markdown** (with YAML frontmatter — title, date, attendees/speakers, tags, source/kind — Obsidian-vault-compatible), **SRT**, **VTT**, **JSON** (structured segments + speakers + summary), **PDF**, **DOCX**. Uses the diarized transcript when available, else the live transcript; includes the summary. Configurable export/storage directory.
- An **"Obsidian note"** export shape (frontmatter + sections) for the meeting + summary.

### Capture / privacy controls (settings)
- **Hidden from screen sharing**: `BrowserWindow.setContentProtection(true)` (and the tray) so the Loqui window is excluded from screen capture/recording; toggle, on by default.
- **Audio-retention policy**: keep / delete-after-processing / never-save. "Delete after processing" removes `mic.wav`/`system.wav` once diarization (PRD-5) has consumed them; "never-save" streams to transcription without persisting WAVs (disables post-hoc re-diarization, clearly noted). Default keeps audio (needed for re-diarization); user can opt into transcripts-only like a comparable local app.
- **Per-app / per-process system-audio filtering**: capture only the meeting app's audio where the OS allows (macOS Core Audio process taps / ScreenCaptureKit per-process on 14.4+; Windows process-loopback on Win10 2004+), reducing cross-app noise. Falls back to full loopback otherwise.
- **VU meters + independent mic/system mute** toggles during capture (finishing the PRD-1 capture UX).

## Out of scope
Auto-record/menubar (PRD-11). The transcription/summary engines (PRD-9/10).

## Acceptance criteria
1. A meeting can be exported to MD (Obsidian frontmatter), SRT, VTT, JSON, PDF, and DOCX; outputs are well-formed and contain the diarized transcript + summary.
2. The app window (and tray) are excluded from screen capture when the privacy toggle is on.
3. The audio-retention policy is honored: "delete after processing" removes the WAVs post-diarization; "never-save" produces a transcript with no WAVs on disk; default keeps them.
4. Per-app audio filtering captures only the target app's audio where supported, with graceful fallback to full loopback.
5. Hermetic tests: each export format from a fixture diarized transcript+summary (well-formed SRT/VTT/JSON/MD; PDF/DOCX produced + openable); retention-policy logic (files deleted/never-written per setting); content-protection flag set; filter-vs-fallback decision. SRT/VTT timing correctness on a fixture.
6. PRD-0..12 stay green; `transcript.live.md` remains the canonical source (exports are derived, read-only over it).

## Notes for implementers
- Exports are pure transforms over the structured transcript + summary — keep them deterministic and unit-tested; PDF/DOCX via a small lib (e.g. a Markdown→PDF/DOCX path) bundled appropriately for packaging (PRD-8).
- `setContentProtection` is cross-platform in Electron (macOS + Windows); verify on both.
- Per-process audio filtering ties into the PRD-1 capture interface + the post-MVP Core Audio taps note; gate by OS capability.
