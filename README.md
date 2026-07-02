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
- [Configuration](#configuration)
- [Tech stack](#tech-stack)
- [Build from source](#build-from-source)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License & acknowledgements](#license--acknowledgements)

## Why Loqui

Most meeting-notes tools send your audio to someone else's cloud. Loqui does the opposite: **all transcription, diarization, and summarization run on your machine**, the transcript is a plain file you own, and your meetings are queryable by *your* AI agent without any account in the middle.

A few things make it different:

- **Two independent streams.** Your microphone (*"You"*) and system audio (*"They"*, captured natively via ScreenCaptureKit) are transcribed **separately**, never merged — so the transcript always knows who's local and who's remote. When you're on speakers, cross-stream echo suppression keeps remote voices from being double-counted as you.
- **The AI can read the transcript but never edits it.** Chat and summaries receive the transcript as read-only context. This is enforced structurally (no writer is reachable from any AI code path) and asserted by byte-identical tests.
- **Your agent gets a memory.** A local [MCP](https://modelcontextprotocol.io) server lets Claude Code / Claude Desktop / Codex search past meetings and pull transcripts — an MCP that connects to your local software, not a cloud account.
- **No tokens, no accounts required.** The default diarizer needs no Hugging Face token; on-device summaries and transcription need no API key. Cloud AI is strictly opt-in.

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
4. On the first recording, grant **Microphone** (your "You" audio) and **Screen Recording** (the other participants' "They" audio — Loqui captures **audio only**, never your screen contents). After granting Screen Recording, **quit and reopen Loqui once** — macOS applies that permission at launch. The transcription model downloads on first use.

> **Known limitation (unsigned builds):** macOS keys the Screen Recording permission to the app's code-signing identity, and unsigned builds get a new identity on every update — so after updating you may need to re-enable Loqui under **System Settings → Privacy & Security → Screen Recording** and relaunch. Your microphone ("You") stream is unaffected.

> **Apple Silicon only.** Intel Macs and Windows are not yet supported.

## Features

| | Feature |
|---|---|
| 🎙️ | **Dual-stream capture** — your mic and the system audio as two independent streams, simultaneously, never merged. System audio is captured natively via **ScreenCaptureKit** (audio-only) in a dedicated Swift helper |
| ⚡ | **Real-time transcription** — streaming [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Silero VAD + LocalAgreement) shows words live; each completed utterance is then **re-decoded with a larger model** in the background, so the transcript converges to high accuracy *during* the meeting, not after it |
| 🔇 | **Echo/bleed suppression** — on speakers, remote voices leak into your mic; Loqui detects mic segments that duplicate a temporally-overlapping system segment and keeps only the "They" copy (short interjections like "yeah" are never suppressed) |
| 📄 | **Live transcript file** — confirmed speech is appended to `transcript.live.md` within ~1s |
| 💬 | **Chat with the live transcript** — ask an AI questions mid-meeting; streamed, markdown-formatted, in-depth answers from a warm on-device model by default. It reads the transcript, never edits it |
| 🗂️ | **Dated, searchable library** — every meeting saved with its date; full-text search across transcripts + summaries (SQLite FTS5) |
| 🗣️ | **Post-meeting diarization** — splits the "They" stream into speakers, fully offline. The **no-token** default ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), Apache-2.0) needs no Hugging Face account; [pyannote.audio](https://github.com/pyannote/pyannote-audio) remains an opt-in, HF-token accuracy upgrade |
| 📝 | **Assistant-grade summaries** — a streamed Markdown document with topic sections plus **Key Takeaways**, **Your Action Items** (tasks assigned to *you*), **Team Action Items**, and **Deliverables** — every item traceable to the transcript, written in the meeting's language |
| 🍎 | **On-device & native AI** — zero-key summary/chat providers (Apple Foundation Models / NaturalLanguage), alongside bring-your-own-key cloud and local agent-CLI options |
| 🧠 | **Agent-queryable memory (MCP)** — a local, read-only MCP server exposes your meetings to your own AI agent; auto-registers with Claude Code |
| 📅 | **Home / Today view** — today's meetings from Google Calendar, one-click **Record**, and a "Meeting Detected" desktop popup ~1 min before timed events with **Join & Record** (the meet link opens in your default browser) |
| 📥 | **File import + Voice Memo** — transcribe an existing audio/video file (decoded via PyAV), or capture a mic-only voice memo; both flow through the same pipeline + library |
| 📤 | **Export & interop** — export any meeting to Markdown (Obsidian) / SRT / VTT / JSON / PDF / DOCX |
| 🔒 | **Private by construction** — recordings are deleted automatically after processing; the window is hidden from screen-share (content protection); everything binds to loopback |
| ⏺️ | **Auto-record + menubar/tray** — opt-in auto start/stop on meeting detection, silence auto-stop, and a menubar app with quick controls |
| 🔄 | **Self-update** — checks GitHub Releases and updates itself (sha256-verified download → swap → relaunch), no code-signing certificate required |

## How it works

```
┌────────────────────────── Electron app ──────────────────────────┐
│  Renderer (React + TS)               Main process (Node + TS)     │
│  • Home / Today (calendar)           • window + app lifecycle     │
│  • Live transcript + meeting         • mic capture orchestration  │
│  • In-call AI chat                   • sidecar supervisor         │
│  • Library (dated + search)          • storage + SQLite/FTS5      │
│  • Summary / diarized view           • OS keychain (keys/tokens)  │
│        │  window.loqui (typed contextBridge)  │                   │
└────────┼──────────────────────────────────────┼───────────────────┘
     mic PCM (16 kHz mono)          spawn + WS (loopback, token)
         │                                      │
         │        ┌── Swift helper (macOS) ──┐  │
         │        │ ScreenCaptureKit system  │  │   system PCM injected by main
         │        │ audio · Apple Speech ·   ├──┤   as the "They" stream
         │        │ Apple Foundation Models │  │
         │        └──────────────────────────┘  │
         ▼                                      ▼
   ┌───────────────────── Python sidecar (FastAPI + WS) ─────────────────────┐
   │  streaming faster-whisper ×2 · Silero VAD · accurate per-utterance      │
   │  finals · echo/bleed dedup · diarization (offline, no-token default)    │
   │  AI provider layer (chat + summaries)                                   │
   └──────────────────────────────────────────────────────────────────────────┘
                                                │ reads (read-only)
                                     ┌──────────▼───────────────────────────┐
                                     │ Loqui MCP server  ──▶  your AI agent │
                                     │ list / search / get transcript+summary│
                                     └───────────────────────────────────────┘
```

The renderer **only** talks to a typed `window.loqui` bridge (context-isolated, sandboxed, no Node access). The **main process owns all persistence** and injects the Swift helper's system-audio PCM into the same frame pipeline the mic uses. The **Python sidecar** does the ML and writes only audio + derived (diarized/summary) files. Cross-process contracts live in [`packages/shared`](packages/shared) as zod schemas with emitted JSON Schema, so TypeScript and Python validate against one source of truth.

A few implementation details worth knowing:

- **Audio wire format.** Both streams travel as 16 kHz mono `pcm_s16le` frames with a 16-byte header (magic, source, sequence, timestamp) — the sidecar routes them by `(meetingId, source)` into two fully independent transcription pipelines.
- **Accuracy without the wait.** The live pipeline emits fast partials (greedy decode), and a per-utterance finalizer re-decodes each completed utterance with a larger model (beam search) off the hot path. Because the live transcript already converges to high accuracy, post-meeting processing skips re-transcription entirely and runs diarization and the summary **concurrently** — notes are ready in roughly the time the summary takes to generate.
- **Crash isolation.** Diarization runs in a separate OS process (a native crash degrades that one meeting to generic speaker labels instead of taking the app down), and the packaged sidecar entrypoint explicitly dispatches worker processes since frozen binaries don't implement `python -m`.

## Agent-queryable memory (MCP)

Loqui ships a local [Model Context Protocol](https://modelcontextprotocol.io) server (`loqui-mcp`) that exposes your meeting store **read-only** to any MCP client. Five tools: `list_meetings`, `search_meetings`, `get_meeting`, `get_transcript`, `get_summary`. It opens the index in read-only mode and has no write path of any kind — your agent can read your meetings, never modify them.

It runs standalone (works even when the app is closed) or managed by the app, over stdio (default) or a loopback-only HTTP transport. The app **auto-registers** itself with Claude Code on first launch, so a fresh agent session sees your meetings even when Loqui is quit. Wiring any other MCP client in manually is one command:

```bash
claude mcp add loqui -- loqui-mcp
```

Then ask your agent things like *"what did we decide in last Tuesday's roadmap meeting?"* — it calls `search_meetings` → `get_transcript` and answers from your local store.

## AI providers

Chat and summaries run through one pluggable provider layer — pick what fits your privacy/quality trade-off:

| Provider | What it is |
|---|---|
| **On-device / native (macOS)** | Zero-key, fully local: Apple Foundation Models or NaturalLanguage. The helper process stays warm across chat turns, so answers start fast. Nothing leaves your Mac. |
| **Anthropic (BYOK)** | Bring your own API key; official SDK. Best quality. |
| **Local agent CLI** | Reuse an agent CLI you already have installed (e.g. Claude Code / Codex, headless) instead of an API key. |

API keys are stored in the OS keychain (Electron `safeStorage`) and injected out-of-band — they're never written to settings or logs.

## Privacy & local-first

- **Nothing leaves your machine** unless you explicitly configure a cloud AI provider or connect a calendar. There are no Loqui servers — there is nothing to phone home to.
- **Recordings don't persist.** The raw WAVs exist only while a meeting is being processed and are deleted automatically when notes are ready. What remains is text you can read: transcripts and summaries.
- **You own the data.** Everything lives under `~/Loqui` (override with `LOQUI_DATA_DIR`):

  ```
  ~/Loqui/
  ├─ index.db                          # SQLite FTS5 index (list + search)
  ├─ models/                           # downloaded ASR/diarization models
  └─ meetings/<id>/
     ├─ meta.json                      # title, dates, platform, participants, status
     ├─ transcript.live.md             # real-time, append-only (You / They)
     ├─ transcript.jsonl               # structured per-segment record
     ├─ transcript.diarized.{json,md}  # speaker-labeled (post-meeting)
     ├─ summary.json                   # AI summary
     └─ audio/                         # mic/system WAVs — auto-deleted after processing
  ```

- **The transcript is sacred.** Only the transcription engine writes it; diarization and summaries are *separate derived files*. Calendar and chat never touch a transcript byte.
- **Loopback only.** The sidecar WS (token-authenticated) and the MCP HTTP transport bind `127.0.0.1` exclusively.
- **Screen Recording ≠ screen capture.** macOS gates system-audio capture behind the Screen Recording permission; Loqui's ScreenCaptureKit session is configured audio-only and never reads a pixel of your screen.
- Calendar integration requests the **narrowest read-only scope** (`calendar.events.readonly`); OAuth tokens live in the OS keychain and are disconnectable in Settings.

## Configuration

Sensible defaults everywhere; everything below is optional. Set env vars before launching (or in CI for packaged builds).

| Variable | Default | What it does |
|---|---|---|
| `LOQUI_DATA_DIR` | `~/Loqui` | Where meetings, the index, and models live |
| `LOQUI_TRANSCRIPTION_LANGUAGE` | auto-detect | Pin the transcription language (e.g. `es`) |
| `LOQUI_LIVE_ACCURATE_MODEL_SIZE` | `medium` | Model used for accurate per-utterance finals |
| `LOQUI_SUMMARY_TIMEOUT_SEC` | `120` | Hard cap on summary generation (0 disables) |
| `LOQUI_DIARIZATION_TIMEOUT_SEC` | `600` | Hard cap on the diarization worker |
| `LOQUI_NATIVE_HELPER_IDLE_SEC` | `240` | Idle time before the warm on-device AI helper is reaped (≤0 disables warm reuse) |
| `LOQUI_BLEED_SIMILARITY` / `LOQUI_BLEED_WINDOW_SEC` / `LOQUI_BLEED_MIN_CHARS` | `0.85` / `1.75` / `12` | Echo/bleed suppression thresholds |
| `LOQUI_GOOGLE_CLIENT_ID` / `LOQUI_GOOGLE_CLIENT_SECRET` | baked in releases | Google Calendar OAuth client. Official releases bake one in at build time; source builds bring their own (see below) |

**Calendar in source builds.** Release binaries include a Google OAuth client. When building from source, create your own OAuth client (Desktop type, `calendar.events.readonly` scope) in the [Google Cloud console](https://console.cloud.google.com/apis/credentials) and export both variables before `pnpm package` (baked at build time) or at runtime (override).

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + React + TypeScript (`contextIsolation`, `sandbox`, no `nodeIntegration`) |
| Native macOS helper | Swift — ScreenCaptureKit system-audio capture, Apple Speech, Apple Foundation Models |
| ML / audio backend | Python sidecar — FastAPI + WebSocket over loopback, shipped as a PyInstaller onedir (users need no Python) |
| Transcription | faster-whisper (CTranslate2, CPU `int8`) + Silero VAD + LocalAgreement streaming, with per-utterance accurate finals |
| Diarization | sherpa-onnx (no-token, offline) by default; pyannote.audio optional |
| Agent memory | MCP server (`@modelcontextprotocol/sdk`) over a read-only SQLite/FTS5 index |
| Contracts | `packages/shared` — zod schemas + emitted JSON Schema (single source of truth) |
| Tooling | pnpm workspaces · [uv](https://docs.astral.sh/uv/) for Python · Vitest · Pytest · Playwright |

## Build from source

> **Prerequisites:** Node ≥ 20 (with `corepack`), pnpm ≥ 9, Python ≥ 3.11, [uv](https://docs.astral.sh/uv/), and Xcode command-line tools (for the Swift helper).

```bash
git clone https://github.com/joaquingit1/loqui.git
cd loqui

corepack enable pnpm                          # use the pinned pnpm
pnpm install                                  # JS workspaces
(cd sidecar && uv sync)                       # Python sidecar deps
pnpm --filter @loqui/desktop build:helper     # Swift helper (system audio + on-device AI)

pnpm dev                                      # launch the Electron app (spawns the sidecar)
```

On the first recording, macOS asks for **Microphone** and **Screen Recording** (system audio); after granting Screen Recording, quit and reopen once. Models download on first use. Diarization works out of the box with the no-token default; the optional pyannote upgrade needs a free [Hugging Face token](https://huggingface.co/pyannote/speaker-diarization-3.1).

**Packaging a distributable app:**

```bash
pnpm --filter @loqui/desktop package   # DMG + zip in apps/desktop/dist-app/
```

Packaging bundles the PyInstaller sidecar, the Swift helper, and the MCP server as app resources — the installed app has zero external dependencies. The build signs the bundled helper and app with the same identity (a local `Loqui Local Dev` certificate if present in your keychain, otherwise ad-hoc): macOS attributes the Screen Recording permission to the code-signing identity, so the helper **must** share the app's identity — `codesign --deep` alone won't sign executables under `Resources/`, which is why the `afterPack` hook exists. Official releases are built by the [tag-triggered CI workflow](.github/workflows/release.yml).

## Project structure

```
loqui/
├─ apps/
│  └─ desktop/            # Electron app — main / preload / renderer (React)
│     └─ native/macos/    # Swift helper: ScreenCaptureKit capture, Apple Speech/FM
├─ sidecar/               # Python ML backend: streaming ASR, diarization, AI providers
├─ mcp-server/            # Local read-only MCP server (loqui-mcp)
├─ packages/
│  ├─ shared/             # Cross-process contract: zod + emitted JSON Schema
│  └─ audio/              # AudioWorklet downmix/resample to 16 kHz mono
└─ scripts/               # Hermetic cross-process smoke harnesses
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

## Troubleshooting

**"Loqui can't be opened because the developer cannot be verified."**
Expected for unsigned builds — System Settings → Privacy & Security → **Open Anyway** (see [Install](#install-macos)).

**The "They" meter never moves / everything is transcribed as "You".**
System audio needs the **Screen Recording** permission, and macOS applies it at launch: check Loqui is enabled under System Settings → Privacy & Security → Screen Recording, then **quit and reopen** the app. After an app update you may need to re-enable it (unsigned builds get a fresh signing identity per release).

**"google calendar isn't configured in this build."**
You're running a source build without an OAuth client. Official releases have one baked in; for source builds see [Configuration](#configuration).

**First transcription is slow to start.**
The ASR models download on first use into `~/Loqui/models` and are cached from then on.

**A meeting is stuck in "processing".**
Post-processing degrades gracefully (a failed stage is skipped with a note), but if the app was force-quit mid-processing, reopen the meeting and use **Regenerate** to rebuild the summary from the saved transcript.

## Contributing

Contributions are welcome. The repo is a pnpm + uv monorepo; please:

1. Run the full gate before opening a PR: `corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test`, `(cd sidecar && uv run pytest -q)`, the smokes, and the E2E.
2. Keep changes **additive and defaulted** — old `meta.json` / transcripts must still load.
3. Respect the invariants: the **AI never edits the transcript**; the two audio streams stay **separate**; new cross-process shapes go in **`packages/shared`**; loopback-only networking.

Bug reports with the meeting's `meta.json` status and reproduction steps are especially useful.

## License & acknowledgements

[MIT](LICENSE). Copyright (c) 2026 Loqui contributors.

Built on excellent open source: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [WhisperLive](https://github.com/collabora/WhisperLive) (vendored streaming core, MIT) · [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) · [pyannote.audio](https://github.com/pyannote/pyannote-audio) · [Silero VAD](https://github.com/snakers4/silero-vad) · [Electron](https://www.electronjs.org/) · [Model Context Protocol](https://modelcontextprotocol.io) · [uv](https://docs.astral.sh/uv/).
