<div align="center">

# Loqui

**Open-source, local-first meeting intelligence.**

Record your meetings, transcribe them in real time, chat with the live transcript, diarize and summarize them afterward — and expose everything to *your own* AI agent through a local MCP server. Private by default; it runs on your machine.

[![CI](https://github.com/joaquingit1/loqui/actions/workflows/ci.yml/badge.svg)](https://github.com/joaquingit1/loqui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Status](https://img.shields.io/badge/status-active%20development-orange)
![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F)
![Python](https://img.shields.io/badge/sidecar-Python%203.11%2B-3776AB)

</div>

---

> **Status: active development (MVP).** The core is working end-to-end (capture → transcribe → library → chat → diarize → summarize → MCP → calendar/Home). Packaging/auto-update and a few competitive features are on the [roadmap](docs/prd/ROADMAP.md). Expect rough edges.

## Table of contents

- [Why Loqui](#why-loqui)
- [Features](#features)
- [How it works](#how-it-works)
- [Agent-queryable memory (MCP)](#agent-queryable-memory-mcp)
- [AI providers](#ai-providers)
- [Privacy & local-first](#privacy--local-first)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License & acknowledgements](#license--acknowledgements)

## Why Loqui

Most meeting-notes tools send your audio to someone else's cloud. Loqui does the opposite: **all transcription, diarization, and summarization run on your machine**, the transcript is a plain file you own, and the data is queryable by *your* AI agent without any account in the middle.

A few things make it different:

- **Two independent streams.** Your microphone (*"You"*) and system audio (*"They"*) are captured and transcribed **separately**, never merged — so the transcript always knows who's local and who's remote.
- **The AI can read the transcript but never edits it.** Chat and summaries receive the transcript as read-only context. This is enforced structurally (no writer is reachable from any AI code path) and asserted by byte-identical tests.
- **Your agent gets a memory.** A local [MCP](https://modelcontextprotocol.io) server lets Claude Code / Claude Desktop / Codex search past meetings and pull transcripts — "an MCP that connects to your local software, not a cloud account."

## Features

| | Feature | Status |
|---|---|---|
| 🎙️ | **Dual-stream capture** — mic *and* system audio as two independent streams, simultaneously | ✅ |
| ⚡ | **Real-time transcription** — two parallel [faster-whisper](https://github.com/SYSTRAN/faster-whisper) pipelines (Silero VAD + LocalAgreement streaming) produce a live `You:` / `They:` transcript | ✅ |
| 📄 | **Live transcript file** — confirmed speech is appended to `transcript.live.md` within ~1s | ✅ |
| 💬 | **Chat with the live transcript** — ask an AI questions mid-meeting; it reads the transcript, never edits it | ✅ |
| 🗂️ | **Dated, searchable library** — every meeting saved with its date; full-text search across transcripts + summaries (SQLite FTS5) | ✅ |
| 🗣️ | **Post-meeting diarization** — [pyannote.audio](https://github.com/pyannote/pyannote-audio) splits the "They" stream into speakers (offline) | ✅ |
| 📝 | **AI summaries** — TL;DR, decisions, action items, topics — generated from the transcript | ✅ |
| 🧠 | **Agent-queryable memory (MCP)** — a local, read-only MCP server exposes your meetings to your own agent | ✅ |
| 📅 | **Home / Today view** — upcoming meetings from Google Calendar / Microsoft 365 / Zoom, with join links + *join & record* | ✅ |
| 👥 | **Google Meet speaker names** — a browser extension maps diarized speakers to real participant names | ✅ |
| 🔄 | **Unsigned self-update** — checks GitHub for releases and updates itself, no code-signing certificate required | 🗺️ planned |
| 🍎 | **Native on-device engines** — Apple Speech / on-device summaries, file import, export (SRT/VTT/PDF/DOCX), no-token diarization | 🗺️ planned |

✅ working · 🚧 in progress · 🗺️ on the [roadmap](docs/prd/ROADMAP.md)

## How it works

```
┌──────────────────────── Electron app ────────────────────────┐
│  Renderer (React + TS)              Main process (Node + TS)  │
│  • Home / Today (calendar)          • app + window lifecycle  │
│  • Live transcript + meeting        • audio capture orchestr. │
│  • In-call AI chat                  • sidecar supervisor      │
│  • Library (dated + search)         • storage + SQLite/FTS5   │
│  • Summary / diarized view          • OS keychain (keys)      │
│         │  window.loqui (typed contextBridge)  │              │
└─────────┼───────────────────────────────────────┼────────────┘
          │ PCM (16 kHz mono)                      │ spawn + WS (loopback, token)
          ▼                                         ▼
   ┌───────────────────────── Python sidecar (FastAPI + WS) ─────────────────────┐
   │  faster-whisper ×2  ·  Silero VAD  ·  pyannote diarization (offline)         │
   │  AI provider layer (chat + summaries)  ·  summarizer                          │
   └──────────────────────────────────────────────────────────────────────────────┘
          ▲                                         │
          │ loopback WS (speaker names)             │ reads (read-only)
   ┌──────┴───────────────┐              ┌──────────▼───────────────────────────┐
   │ Browser extension    │              │ Loqui MCP server  ──▶  your AI agent  │
   │ (Google Meet DOM)    │              │ list / search / get transcript+summary │
   └──────────────────────┘              └────────────────────────────────────────┘
```

The renderer **only** talks to a typed `window.loqui` bridge (context-isolated, sandboxed, no Node access). The **main process owns all persistence**; the **Python sidecar** does the ML and writes only audio + derived (diarized/summary) files. Cross-process contracts live in [`packages/shared`](packages/shared) as zod schemas with emitted JSON Schema, so TypeScript and Python validate against one source. See [`docs/prd/`](docs/prd/) for the full design and [`docs/contract/FRONTEND-CONTRACT.md`](docs/contract/FRONTEND-CONTRACT.md) for the UI integration surface.

## Agent-queryable memory (MCP)

Loqui ships a local [Model Context Protocol](https://modelcontextprotocol.io) server (`loqui-mcp`) that exposes your meeting store **read-only** to any MCP client. Five tools: `list_meetings`, `search_meetings`, `get_meeting`, `get_transcript`, `get_summary`. It opens the index in read-only mode and has no write path of any kind — your agent can read your meetings, never modify them.

It runs standalone (works even when the app is closed) or managed by the app, over stdio (default) or a loopback-only HTTP transport. Wiring it into Claude Code is one command:

```bash
claude mcp add loqui -- loqui-mcp
```

Then ask your agent things like *"what did we decide in last Tuesday's roadmap meeting?"* — it calls `search_meetings` → `get_transcript` and answers from your local store. The app's **Settings → MCP** panel generates ready-to-paste config snippets for Claude Code, Claude Desktop, and Codex.

## AI providers

Chat and summaries run through one pluggable provider layer — pick what fits your privacy/quality trade-off:

| Provider | What it is |
|---|---|
| **Anthropic (BYOK)** | Bring your own API key; official SDK; default model `claude-opus-4-8`. Best quality. |
| **Ollama** | Fully offline, local, OpenAI-compatible endpoint. |
| **Local Claude Code / Codex CLI** | Reuse an agent CLI you already have installed (headless) instead of an API key. |

API keys are stored in the OS keychain (Electron `safeStorage`) and injected out-of-band — they're never written to settings or logs. *(On-device summaries via Apple's native models are on the roadmap.)*

## Privacy & local-first

- **Nothing leaves your machine** unless you explicitly configure a cloud AI provider or connect a calendar. There are no Loqui servers — there is nothing to phone home to.
- **You own the data.** Everything lives under `~/Loqui` (override with `LOQUI_DATA_DIR`):

  ```
  ~/Loqui/
  ├─ index.db                          # SQLite FTS5 index (list + search)
  └─ meetings/<id>/
     ├─ meta.json                      # title, dates, platform, participants, status
     ├─ transcript.live.md             # real-time, append-only (You / They)
     ├─ transcript.jsonl               # structured per-segment record
     ├─ transcript.diarized.{json,md}  # speaker-labeled (post-meeting)
     ├─ summary.json                   # AI summary
     └─ audio/{mic,system}.wav         # raw captured streams
  ```

- **The transcript is sacred.** Only the transcription engine writes it; diarization and summaries are *separate derived files*. Calendar and chat never touch a transcript byte.
- **Loopback only.** The sidecar WS (token-authenticated), the MCP HTTP transport, and the browser-extension channel all bind `127.0.0.1`.
- Calendar integration requests the **narrowest read-only scope**; OAuth tokens live in the OS keychain and are disconnectable.

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + React + TypeScript (`contextIsolation`, `sandbox`, no `nodeIntegration`) |
| ML / audio backend | Python sidecar — FastAPI + WebSocket over loopback |
| Transcription | faster-whisper (CTranslate2, CPU `int8`) + Silero VAD + LocalAgreement streaming |
| Diarization | pyannote.audio 3.1 (offline, CPU-capable) |
| Agent memory | MCP server (`@modelcontextprotocol/sdk`) over a read-only SQLite/FTS5 index |
| Contracts | `packages/shared` — zod schemas + emitted JSON Schema (single source of truth) |
| Tooling | pnpm workspaces · [uv](https://docs.astral.sh/uv/) for Python · Vitest · Pytest · Playwright |

## Getting started

> **Prerequisites:** Node ≥ 20 (with `corepack`), pnpm ≥ 9, Python ≥ 3.11, and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/joaquingit1/loqui.git
cd loqui

corepack enable pnpm        # use the pinned pnpm
pnpm install                # JS workspaces
(cd sidecar && uv sync)     # Python sidecar deps

pnpm dev                    # launch the Electron app (spawns the Python sidecar)
```

On first launch, macOS will ask for **screen-recording permission** (required to capture system audio). The faster-whisper model downloads on first use; pyannote diarization additionally needs a free [Hugging Face token](https://huggingface.co/pyannote/speaker-diarization-3.1) (configured in Settings) until the no-token diarizer lands.

## Project structure

```
loqui/
├─ apps/
│  ├─ desktop/        # Electron app — main / preload / renderer (React)
│  └─ extension/      # MV3 browser extension (Google Meet speaker names)
├─ sidecar/           # Python ML backend: whisper ×2, pyannote, AI providers, summarizer
├─ mcp-server/        # Local read-only MCP server (loqui-mcp)
├─ packages/
│  ├─ shared/         # Cross-process contract: zod + emitted JSON Schema
│  └─ audio/          # AudioWorklet downmix/resample to 16 kHz mono
├─ docs/
│  ├─ prd/            # Per-milestone product specs + ROADMAP
│  └─ contract/       # Frontend ↔ backend integration contract
├─ scripts/           # Hermetic cross-process smoke harnesses
└─ .github/workflows/ # CI (macOS + Windows)
```

## Testing

Loqui keeps a real test pyramid, all hermetic (a temp `LOQUI_DATA_DIR`, no network, no real models):

```bash
corepack pnpm -r typecheck                 # TypeScript
corepack pnpm -r lint                      # eslint
corepack pnpm -r test                      # Vitest (unit/component)
(cd sidecar && uv run pytest -q)           # Python unit tests
pnpm smoke:foundation                      # cross-process smokes spawn the *real* sidecar / MCP
pnpm smoke:mcp                             # …foundation/audio/transcription/meeting/chat/postprocess/mcp/calendar
pnpm --filter @loqui/desktop test:e2e      # Playwright-Electron full-app E2E
```

- **Smokes** drive the actual sidecar and the real MCP server over the real WS/stdio seams — they catch integration bugs unit tests hide.
- **E2E** launches the packaged Electron app via Playwright and asserts the window mounts, `window.loqui` is exposed with no Node leak, and the sidecar round-trips.
- **CI** runs the full suite on **macOS + Windows** across Node 20/22, with a separate Electron E2E job.

> The desktop app uses `better-sqlite3` (a native module): `pnpm test` rebuilds it for the Node ABI; the E2E needs the Electron ABI (`pnpm --filter @loqui/desktop exec electron-rebuild -f -w better-sqlite3`).

## Roadmap

Loqui is built milestone-by-milestone; each is specced in [`docs/prd/`](docs/prd/) and executed behind a hard "greenlight" gate (build → adversarial review → objective checks). See [`docs/prd/ROADMAP.md`](docs/prd/ROADMAP.md) for the full plan.

**Done:** foundation & contracts · dual-stream capture · real-time transcription · transcript store + dated library · in-call AI chat · diarization + summaries · local MCP server · calendar + Home view · Google Meet speaker names.

**Up next:** packaging + unsigned GitHub auto-updater.

**Planned:** pluggable transcription engines (Apple Speech / WhisperKit) · on-device & native summaries · auto-record + menubar/tray · file import + voice memo · export (SRT/VTT/PDF/DOCX) + capture/privacy controls · no-token local diarization.

## Contributing

Contributions are welcome. The repo is a pnpm + uv monorepo; please:

1. Run the full gate before opening a PR: `corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test`, `(cd sidecar && uv run pytest -q)`, the smokes, and the E2E.
2. Keep changes **additive and defaulted** — old `meta.json`/transcripts must still load.
3. Respect the invariants: the **AI never edits the transcript**; the two audio streams stay **separate**; new cross-process shapes go in **`packages/shared`**; loopback-only networking.

Issues and PRs welcome — start with [`docs/prd/ROADMAP.md`](docs/prd/ROADMAP.md) to see where things are headed.

## License & acknowledgements

[MIT](LICENSE).

Built on excellent open source: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [pyannote.audio](https://github.com/pyannote/pyannote-audio) · [Silero VAD](https://github.com/snakers4/silero-vad) · [Electron](https://www.electronjs.org/) · [Model Context Protocol](https://modelcontextprotocol.io) · [uv](https://docs.astral.sh/uv/).
