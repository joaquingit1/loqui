# Loqui

**Open-source, local-first meeting intelligence.** A privacy-first, fully in-house alternative to meeting-notes for macOS and Windows.

Loqui records your meetings, transcribes them in real time, lets you chat with the live transcript, diarizes and summarizes them afterward, and exposes everything to *your own* AI agent through a local MCP server — no cloud account required.

> Status: **in active development** (MVP). See [`docs/prd/`](docs/prd/) for the full product spec and [`docs/prd/ROADMAP.md`](docs/prd/ROADMAP.md) for the build order.

## What it does

- 🎙️ **Dual-stream capture** — records your microphone *and* system audio (everyone else) as two **independent** streams, simultaneously.
- ⚡ **Real-time transcription** — two parallel [faster-whisper](https://github.com/SYSTRAN/faster-whisper) pipelines produce a live `You said:` / `They said:` transcript, written to a text file the instant words are confirmed.
- 💬 **Chat with the live transcript** — ask an AI questions during the call. The AI reads the transcript but **can never edit it** (a hard architectural invariant).
- 🗣️ **Post-meeting diarization** — [pyannote.audio](https://github.com/pyannote/pyannote-audio) splits the "They" stream into speakers; on Google Meet, a browser extension maps them to **real names**.
- 📝 **AI summaries** — every meeting is saved with its date, diarized, and summarized.
- 🧠 **Agent-queryable memory (MCP)** — a local MCP server lets your Claude Code / Codex / Claude Desktop search past meetings and fetch transcripts on demand.
- 🔄 **Self-updating** — checks GitHub for new releases and updates itself, even **unsigned** (no certificate required).

## AI provider options

The in-app chat and summaries are powered by a pluggable provider — pick one:

1. **BYOK Anthropic API** (Claude) — bring your own API key.
2. **Local Ollama** — fully offline, OpenAI-compatible endpoint.
3. **Local Claude Code / Codex CLI** — use your already-installed agent in headless mode instead of an API key.

## Architecture (high level)

```
Electron app (React UI + Node main)  ──spawn──▶  Python sidecar
  • audio capture (mic + loopback)                • faster-whisper x2 + Silero VAD
  • self-updater (GitHub)                         • pyannote diarization (offline)
  • storage / SQLite index                        • AI provider layer + summarizer
        │                                                  │
   Browser extension                            Local MCP server  ──▶  your AI agent
   (Google Meet speaker names)                  (read-only over the meeting store)
```

See the approved system design and per-component specs in [`docs/prd/`](docs/prd/).

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + React + TypeScript |
| ML / audio backend | Python sidecar (faster-whisper, pyannote.audio, Silero VAD) |
| Diarization | pyannote.audio 3.1 (offline, CPU-capable) |
| Agent memory | MCP server (stdio + HTTP) over a local SQLite/FTS index |
| Auto-update | Custom GitHub release self-updater (works unsigned) |

## Development

> Requires Node ≥ 20, pnpm ≥ 9, Python ≥ 3.11, and [uv](https://docs.astral.sh/uv/).

```bash
pnpm install
pnpm dev          # launch the Electron app (spawns the Python sidecar)
```

Full contributor setup lands with PRD-0. See [`docs/prd/PRD-0-foundation.md`](docs/prd/PRD-0-foundation.md).

## License

[MIT](LICENSE).
