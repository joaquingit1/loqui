# Loqui — PRD Roadmap & Build Order

Loqui is built as a sequence of milestone PRDs. PRD-0 defines the shared contracts every other PRD depends on. PRDs 1–3 form the core real-time vertical slice (capture → transcribe → live file + library). PRDs 4–8 layer on intelligence, agent-memory, speaker names, and distribution.

Each PRD is executed with the **orchestrated-build** workflow: Foundation (lock the shared contract) → parallel Build over disjoint files → Integrate → adversarial cold Review → Fix → **Greenlight gate**. We only advance when a PRD greenlights.

## Build order

| # | PRD | Why here |
|---|---|---|
| 0 | [Foundation, contracts & scaffolding](PRD-0-foundation.md) | Everything depends on the IPC/event contracts, storage, and the runnable shell. |
| 1 | [Dual-stream audio capture](PRD-1-audio-capture.md) | Produces the PCM the rest of the pipeline consumes. |
| 2 | [Real-time transcription engine](PRD-2-transcription.md) | Turns PCM into live transcript segments. |
| 3 | [Live transcript store, lifecycle & library](PRD-3-transcript-store.md) | Persists meetings with dates; the real-time file + library. |
| 4 | [In-call AI chat + provider abstraction](PRD-4-ai-chat.md) | Read-only chat; the provider layer reused by summaries. |
| 5 | [Post-meeting diarization + AI summaries](PRD-5-diarization-summaries.md) | Speaker-splits "They" + summarizes each meeting. |
| 7 | [Local MCP server](PRD-7-mcp-server.md) | Agent-queryable meeting memory — sequenced before the fragile Meet extension. |
| 6 | [Google Meet speaker-name attribution](PRD-6-speaker-names.md) | Maps diarized speakers to real names (highest-risk feature). |
| 8 | [Packaging + custom unsigned auto-updater](PRD-8-packaging-updater.md) | Installers + self-update with no signing certificate. |

> Note the deliberate **7 before 6** ordering: the MCP agent-memory feature is a top priority and is far more robust than the Google Meet DOM scraping, so it lands earlier.

## Competitive-parity build order (after the core 0–8)

Added after a deep comparison against **a comparable local app** (a comparable local app) — a polished macOS-only local app. Loqui already beats it on the differentiators (real-time streaming, separate You/They streams, in-call chat, cross-meeting search, MCP agent-memory, Google-Meet speaker-name auto-attribution, browser-meeting support, BYOK cloud quality, cross-platform, auto-update). These PRDs close the remaining gaps so Loqui is a strict superset. Sequenced **after** the core (decision: core-first); all four buckets are v1 must-haves.

| # | PRD | Closes (a comparable local app parity / beyond) |
|---|---|---|
| 9 | [Pluggable transcription engines (incl. Apple-native)](PRD-9-transcription-engines.md) | Engine choice + **Apple Speech** (zero-download, on-device) + WhisperKit/MLX (ANE speed on Apple Silicon). |
| 10 | [On-device & native summary providers](PRD-10-ondevice-summaries.md) | Zero-config on-device summaries (**Apple NaturalLanguage / Foundation Models**, bundled MLX) + custom prompt templates — while keeping our BYOK-cloud edge. |
| 11 | [Auto-record on meeting detection + menubar/tray](PRD-11-auto-record-menubar.md) | Auto start/stop on meeting detection (native **and** browser), silence auto-stop, tray presence. |
| 12 | [File import transcription + Voice Memo](PRD-12-file-import-voice-memo.md) | Transcribe an existing audio/video file; mic-only quick-capture mode. |
| 13 | [Export & interop + capture/privacy controls](PRD-13-export-privacy.md) | SRT/VTT/JSON/PDF/DOCX + Obsidian notes; hidden-from-screen-share; don't-keep-audio; per-app audio filtering. |

**Fold-ins** (executed inside their PRD, not standalone): custom summary prompt templates → PRD-10; hidden-from-screen-share + silence auto-stop + mic/system mute → PRD-11/PRD-13.

Native macOS engines/providers (PRD-9/10) ship via a small notarizable **Swift helper** the sidecar invokes (same pattern as the audio-capture helper), with graceful fallback to faster-whisper / cloud on Windows.

## Cross-cutting invariants (apply to every PRD)

1. **The AI never edits the transcript.** Transcript files are written *only* by the transcription engine. No provider/chat/summary code path may mutate them. Enforced structurally and asserted in tests.
2. **Local-first / privacy.** No data leaves the machine unless the user explicitly configures a cloud AI provider. Models and tokens are never bundled or transmitted to Loqui servers (there are none).
3. **Two streams stay separate.** Mic ("You") and system ("They") are independent end to end; they are only correlated by timestamp, never merged into one stream.
4. **Cross-platform.** macOS (13+) and Windows (10+). No NVIDIA-GPU-only dependencies (rules out Sortformer).
5. **Contracts live in `packages/shared`.** Schemas are the single source of truth, consumed by desktop (TS) and sidecar (generated/validated).
