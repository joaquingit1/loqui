<div align="center">
<img width="1916" height="821" alt="loqui_banner" src="https://github.com/user-attachments/assets/49ef2227-f04b-4f01-8dd1-6892f592000b" />

# Loqui

**Open-source, local-first meeting intelligence — your meetings, transcribed, summarized, and queryable, all on your own machine.**

Record your meetings, transcribe them in real time, chat with the live transcript, then diarize and summarize them afterward — and expose everything to *your own* AI agent through a local MCP server. Private by default; it runs entirely on your Mac.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/joaquingit1/loqui?label=release&color=success)](https://github.com/joaquingit1/loqui/releases/latest)
![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-lightgrey)
![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F)
![Python](https://img.shields.io/badge/sidecar-Python%203.11%2B-3776AB)

</div>

---

## Table of contents

- [Why Loqui](#why-loqui)
- [Loqui vs. typical alternatives](#loqui-vs-typical-alternatives)
- [Install (macOS)](#install-macos)
- [Features](#features)
- [How it works](#how-it-works)
- [Agent-queryable memory (MCP)](#agent-queryable-memory-mcp)
- [AI providers](#ai-providers)
- [Privacy & local-first](#privacy--local-first)
- [Tech stack](#tech-stack)
- [Build from source](#build-from-source)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Contributing](#contributing)
- [License & acknowledgements](#license--acknowledgements)

## Why Loqui

Most meeting-notes tools send your audio to someone else's cloud. Loqui does the opposite: **all transcription, diarization, and summarization run on your machine**, the transcript is a plain file you own, and your meetings are queryable by *your* AI agent without any account in the middle.

A few things make it different:

- **Two independent streams.** Your microphone (*"You"*) and system audio (*"They"*) are captured and transcribed **separately**, never merged — so the transcript always knows who's local and who's remote.
- **The AI can read the transcript but never edits it.** Chat and summaries receive the transcript as read-only context. This is enforced structurally (no writer is reachable from any AI code path) and asserted by byte-identical tests.
- **Your agent gets a memory.** A local [MCP](https://modelcontextprotocol.io) server lets Claude Code / Claude Desktop / Codex search past meetings and pull transcripts — an MCP that connects to your local software, not a cloud account.
- **No tokens, no accounts required.** The default diarizer needs no Hugging Face token; on-device summaries and transcription engines need no API key. Cloud AI is strictly opt-in.

## Loqui vs. typical alternatives

| | **Loqui** | **Typical cloud meeting-notes apps** | **Other local tools** |
|---|---|---|---|
| Where audio is processed | On-device, on your Mac | ❌ Uploaded to a vendor cloud | ✅ On-device |
| Account / sign-up required | None | ❌ Account (often a subscription) | ⚠️ Varies |
| Your transcript | A plain Markdown file you own | ❌ Locked inside the vendor's app | ⚠️ Often app-specific formats |
| Mic vs. system audio | ✅ Two independent never-merged streams ("You" / "They") | ⚠️ Usually a single mixed track | ⚠️ Often mic-only |
| AI editing your transcript | ✅ AI reads, **never** edits (structurally enforced) | ⚠️ AI may rewrite/"clean up" your notes | ⚠️ Varies |
| Agent-queryable memory | ✅ Local read-only MCP server for your own agent | ❌ Closed; query only inside the app | ⚠️ Rare |
| Diarization | ✅ No-token, on-device by default | ⚠️ Cloud-side | ⚠️ Often token/account-gated |
| AI summaries | ✅ On-device / native, or bring-your-own-key cloud | ⚠️ Vendor cloud only | ⚠️ Limited or none |
| Source & license | ✅ Open-source (MIT) | ❌ Proprietary | ⚠️ Mixed |
| Updates | ✅ Built-in self-update | ✅ Managed | ⚠️ Often manual |

*Cloud meeting-notes apps are convenient, but they typically require an account, send your audio off-device, and keep your data inside their product. Loqui is for people who would rather keep all of that on their own machine.*

## Install (macOS)

1. Download the latest **`Loqui-<version>-arm64-mac.dmg`** from the [**Releases** page](https://github.com/joaquingit1/loqui/releases/latest).
2. Open the `.dmg` and drag **Loqui** into your **Applications** folder.
3. **First launch (unsigned app).** Loqui is open-source and ships **unsigned** (no paid Apple Developer certificate), so macOS will warn that *"Loqui can't be opened because the developer cannot be verified."* This is expected. To allow it:
   - Open **System Settings → Privacy & Security**, scroll to the **Security** section, and click **"Open Anyway"** next to the Loqui notice — then confirm.
4. On first recording, grant **Screen Recording** (to capture system / "They" audio) and **Microphone** (your "You" audio) permissions when prompted. The transcription model downloads on first use.

> **Known limitation (unsigned builds + macOS 15+):** on macOS, the other participants' audio ("They") is captured natively via **ScreenCaptureKit**, which needs the one-time **Screen Recording** permission (granted on first record). Because these builds are unsigned, macOS may re-prompt for that grant after an app update — just re-enable Loqui under **System Settings → Privacy & Security → Screen Recording**. Your own microphone ("You") is unaffected.

> **Apple Silicon only.** Intel Macs and Windows are not yet supported.

## Features

| | Feature |
|---|---|
| 🎙️ | **Dual-stream capture** — mic *and* system audio as two independent streams, simultaneously, never merged |
| ⚡ | **Real-time transcription** — two parallel [faster-whisper](https://github.com/SYSTRAN/faster-whisper) pipelines (Silero VAD + LocalAgreement streaming) produce a live `You:` / `They:` transcript |
| 🗣️ | **Pluggable transcription engines** — choose faster-whisper (cross-platform) or, on macOS, on-device Apple Speech / WhisperKit on the Apple Neural Engine; falls back to faster-whisper gracefully wherever a native engine is unavailable |
| 📄 | **Live transcript file** — confirmed speech is appended to `transcript.live.md` within ~1s |
| 💬 | **Chat with the live transcript** — ask an AI questions mid-meeting; it reads the transcript, never edits it (enforced structurally + asserted by byte-identical tests) |
| 🗂️ | **Dated, searchable library** — every meeting saved with its date; full-text search across transcripts + summaries (SQLite FTS5) |
| 🗣️ | **Post-meeting diarization** — splits the "They" stream into speakers, offline. A **no-token** diarizer ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0) is the default — no Hugging Face token or account needed; [pyannote.audio](https://github.com/pyannote/pyannote-audio) remains an opt-in, HF-token accuracy upgrade |
| 📝 | **AI summaries** — title/overview, TL;DR, decisions, action items, and topics, rendered as a streamed Markdown document — not a wall of cards |
| 🍎 | **On-device & native summaries** — zero-key on-device summary/chat providers (Apple Foundation Models / NaturalLanguage / a bundled local model) + custom prompt templates, alongside a bring-your-own-key cloud option |
| 🧠 | **Agent-queryable memory (MCP)** — a local, read-only MCP server exposes your meetings to your own AI agent |
| 📅 | **Home / Today view** — upcoming meetings from Google Calendar with join links + *join & record*, and a "Meeting Detected" desktop popup ~1 min before timed events |
| 📥 | **File import + Voice Memo** — transcribe an existing audio/video file (decoded via PyAV), or capture a mic-only voice memo; both flow through the same pipeline + library |
| 📤 | **Export & interop** — export any meeting to Markdown (Obsidian) / SRT / VTT / JSON / PDF / DOCX |
| 🔒 | **Capture & privacy controls** — hide the window from screen-share; audio-retention policy (keep / delete-after-processing / never-save) |
| ⏺️ | **Auto-record + menubar/tray** — opt-in auto start/stop on meeting detection, silence auto-stop, and a menubar/tray app with quick controls |
| 🔄 | **Self-update** — checks GitHub Releases and updates itself (sha256-verified download → swap → relaunch), no code-signing certificate required |

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
   │  faster-whisper ×2  ·  Silero VAD  ·  diarization (offline, no-token default)│
   │  AI provider layer (chat + summaries)  ·  summarizer                          │
   └──────────────────────────────────────────────────────────────────────────────┘
          ▲                                         │
          │ loopback WS (speaker names)             │ reads (read-only)
   ┌──────┴───────────────┐              ┌──────────▼───────────────────────────┐
   │ Browser extension    │              │ Loqui MCP server  ──▶  your AI agent  │
   │ (meeting DOM)        │              │ list / search / get transcript+summary │
   └──────────────────────┘              └────────────────────────────────────────┘
```

The renderer **only** talks to a typed `window.loqui` bridge (context-isolated, sandboxed, no Node access). The **main process owns all persistence**; the **Python sidecar** does the ML and writes only audio + derived (diarized/summary) files. Cross-process contracts live in [`packages/shared`](packages/shared) as zod schemas with emitted JSON Schema, so TypeScript and Python validate against one source of truth.

## Agent-queryable memory (MCP)

Loqui ships a local [Model Context Protocol](https://modelcontextprotocol.io) server (`loqui-mcp`) that exposes your meeting store **read-only** to any MCP client. Five tools: `list_meetings`, `search_meetings`, `get_meeting`, `get_transcript`, `get_summary`. It opens the index in read-only mode and has no write path of any kind — your agent can read your meetings, never modify them.

It runs standalone (works even when the app is closed) or managed by the app, over stdio (default) or a loopback-only HTTP transport. The app **auto-registers** itself for Claude Code so a fresh agent session sees your meetings even when Loqui is quit. Wiring it in manually is one command:

```bash
claude mcp add loqui -- loqui-mcp
```

Then ask your agent things like *"what did we decide in last Tuesday's roadmap meeting?"* — it calls `search_meetings` → `get_transcript` and answers from your local store. The app's **Settings → MCP** panel generates ready-to-paste config snippets for Claude Code, Claude Desktop, and Codex.

## AI providers

Chat and summaries run through one pluggable provider layer — pick what fits your privacy/quality trade-off:

| Provider | What it is |
|---|---|
| **On-device / native (macOS)** | Zero-key, fully local: Apple Foundation Models, NaturalLanguage, or a bundled local model. Nothing leaves your Mac. |
| **Anthropic (BYOK)** | Bring your own API key; official SDK. Best quality. |
| **Local agent CLI** | Reuse an agent CLI you already have installed (e.g. Claude Code / Codex, headless) instead of an API key. |

Prompt templates are customizable. API keys are stored in the OS keychain (Electron `safeStorage`) and injected out-of-band — they're never written to settings or logs.

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
- **Audio-retention is yours to set:** keep recordings, delete-after-processing, or never-save.
- Calendar integration requests the **narrowest read-only scope**; OAuth tokens live in the OS keychain and are disconnectable.

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + React + TypeScript (`contextIsolation`, `sandbox`, no `nodeIntegration`) |
| ML / audio backend | Python sidecar — FastAPI + WebSocket over loopback |
| Transcription | faster-whisper (CTranslate2, CPU `int8`) + Silero VAD + LocalAgreement streaming; optional on-device Apple Speech / WhisperKit (ANE) on macOS |
| Diarization | sherpa-onnx (no-token, offline) by default; pyannote.audio optional |
| Agent memory | MCP server (`@modelcontextprotocol/sdk`) over a read-only SQLite/FTS5 index |
| Contracts | `packages/shared` — zod schemas + emitted JSON Schema (single source of truth) |
| Tooling | pnpm workspaces · [uv](https://docs.astral.sh/uv/) for Python · Vitest · Pytest · Playwright |

## Build from source

> **Prerequisites:** Node ≥ 20 (with `corepack`), pnpm ≥ 9, Python ≥ 3.11, and [uv](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/joaquingit1/loqui.git
cd loqui

corepack enable pnpm        # use the pinned pnpm
pnpm install                # JS workspaces
(cd sidecar && uv sync)     # Python sidecar deps

pnpm dev                    # launch the Electron app (spawns the Python sidecar)
```

On first launch, macOS will ask for **Screen Recording** permission (required to capture system audio). The faster-whisper model downloads on first use. Diarization works out of the box with the no-token default; the optional pyannote upgrade additionally needs a free [Hugging Face token](https://huggingface.co/pyannote/speaker-diarization-3.1), configured in Settings.

## Project structure

```
loqui/
├─ apps/
│  └─ desktop/        # Electron app — main / preload / renderer (React)
├─ sidecar/           # Python ML backend: whisper ×2, diarization, AI providers, summarizer
├─ mcp-server/        # Local read-only MCP server (loqui-mcp)
├─ packages/
│  ├─ shared/         # Cross-process contract: zod + emitted JSON Schema
│  └─ audio/          # AudioWorklet downmix/resample to 16 kHz mono
└─ scripts/           # Hermetic cross-process smoke harnesses
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

> The desktop app uses `better-sqlite3` (a native module): `pnpm test` rebuilds it for the Node ABI; the E2E needs the Electron ABI (`pnpm --filter @loqui/desktop exec electron-rebuild -f -w better-sqlite3`).

## Contributing

Contributions are welcome. The repo is a pnpm + uv monorepo; please:

1. Run the full gate before opening a PR: `corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test`, `(cd sidecar && uv run pytest -q)`, the smokes, and the E2E.
2. Keep changes **additive and defaulted** — old `meta.json` / transcripts must still load.
3. Respect the invariants: the **AI never edits the transcript**; the two audio streams stay **separate**; new cross-process shapes go in **`packages/shared`**; loopback-only networking.

Issues and PRs welcome.

## License & acknowledgements

[MIT](LICENSE). Copyright (c) 2026 Loqui contributors.

Built on excellent open source: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [pyannote.audio](https://github.com/pyannote/pyannote-audio) · [Silero VAD](https://github.com/snakers4/silero-vad) · [Electron](https://www.electronjs.org/) · [Model Context Protocol](https://modelcontextprotocol.io) · [uv](https://docs.astral.sh/uv/).
