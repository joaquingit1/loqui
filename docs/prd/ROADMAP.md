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

## Cross-cutting invariants (apply to every PRD)

1. **The AI never edits the transcript.** Transcript files are written *only* by the transcription engine. No provider/chat/summary code path may mutate them. Enforced structurally and asserted in tests.
2. **Local-first / privacy.** No data leaves the machine unless the user explicitly configures a cloud AI provider. Models and tokens are never bundled or transmitted to Loqui servers (there are none).
3. **Two streams stay separate.** Mic ("You") and system ("They") are independent end to end; they are only correlated by timestamp, never merged into one stream.
4. **Cross-platform.** macOS (13+) and Windows (10+). No NVIDIA-GPU-only dependencies (rules out Sortformer).
5. **Contracts live in `packages/shared`.** Schemas are the single source of truth, consumed by desktop (TS) and sidecar (generated/validated).
