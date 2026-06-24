# PRD-10 — On-Device & Native Summary Providers (+ custom prompts)

## Goal
Add **zero-config, fully on-device summary providers** to the PRD-4 provider abstraction — so a user gets summaries (and chat) with **no API key and no separate install** — matching a comparable local app's on-device summary choice (Apple NaturalLanguage, Qwen3, Gemma via MLX) while keeping our best-quality BYOK-cloud option that they lack. Also add **custom summary prompt templates**.

## Background (competitive)
a comparable local app summarizes 100% on-device with selectable models (Apple NaturalLanguage + MLX Qwen3/Gemma) and three custom-prompt slots — zero key, zero cloud. Loqui's PRD-4 providers are BYOK Anthropic, local Ollama (needs install), and local Claude Code/Codex CLI. We lack a **zero-config** on-device option and **custom prompt templates**. This PRD adds native/bundled on-device providers through the existing `ChatProvider` interface (reused by both chat and PRD-5 summaries), so we end up offering *both* zero-config-local *and* best-quality-cloud — a superset of theirs.

## Scope / deliverables
- New `ChatProvider` implementations (sidecar, behind the existing interface):
  - **Apple Foundation Models** (macOS 26 on-device Apple-Intelligence LLM) and/or **Apple NaturalLanguage** (extractive highlights/topics) via the **PRD-9 Swift helper** — zero download, zero key, on-device. Preferred generative target: Foundation Models; NaturalLanguage as an extractive fallback.
  - **Bundled MLX small model** (e.g. a Qwen/Gemma-class instruct model) on Apple Silicon — downloaded on first use, then fully offline, no Ollama dependency.
  - (Ollama + Anthropic + CLI already exist from PRD-4.)
- **Provider/model selection** in Settings spanning chat *and* summaries, with availability/download/permission status. A clear "fully on-device (no key)" vs "cloud (BYOK, higher quality)" distinction.
- **Custom summary prompt templates**: configurable named prompt slots (with placeholders) used by PRD-5's summary job and offered in the summary UI. Default templates for TL;DR / decisions / action-items.
- Reuse PRD-5's summary pipeline + the read-only transcript accessor — **the AI still never edits the transcript** (the byte-identical invariant continues to hold for every provider, native ones included).
- Cross-platform fallback: native providers are macOS-only; Windows users get Ollama/BYOK/cloud; the default summary provider is chosen by platform + availability.

## Out of scope
Transcription engines (PRD-9). The Swift helper itself is established in PRD-9; this PRD adds summary methods to it.

## Acceptance criteria
1. On macOS, a user can generate a meeting summary with **no API key and no Ollama install** (native on-device provider), via the same provider selector used for chat.
2. Custom prompt templates: a user can define/select a summary prompt; PRD-5's summary job uses it; regeneration with a different template works.
3. The read-only invariant holds for every provider, including native ones (transcript byte-identical after summary; provider has no write path).
4. Switching providers takes effect without restart; native providers are absent/disabled on Windows with cloud/Ollama as fallback.
5. Hermetic tests: native providers behind the injectable interface with a stub helper; custom-template plumbing; the invariant test. Opt-in real native test on macOS.
6. PRD-0..9 stay green.

## Notes for implementers
- Everything routes through the PRD-4 `ChatProvider` + `make_provider_selector`; a native provider is just another backend. Keep the provider read-only (it returns text; a separate writer persists `summary.md`).
- Apple Foundation Models availability is gated (macOS 26 + Apple Intelligence enabled) — probe via the helper and degrade gracefully.
