# PRD-4 — In-Call AI Chat + Provider Abstraction (Read-Only)

## Goal
Let the user chat with an AI about the **live** transcript during a meeting. The AI reads the transcript as context but can **never edit it**. Ship a pluggable provider layer — BYOK Anthropic, local Ollama, or a locally-installed Claude Code / Codex CLI — reused later by summaries (PRD-5).

## Background
This is a headline feature and the home of the **AI-never-edits-the-transcript** invariant. The provider abstraction is deliberately built here because PRD-5 summaries depend on it.

## Scope / deliverables

### Provider abstraction (`sidecar/loqui_sidecar/providers/`)
A single `ChatProvider` interface (`stream_chat(messages, context) -> async tokens`) with three implementations:
1. **Anthropic (BYOK)** — user-supplied API key; latest Claude model; streaming.
2. **Ollama (local)** — OpenAI-compatible endpoint at `http://localhost:11434`; user picks a pulled model; fully offline.
3. **Local agent CLI** — invoke an installed **Claude Code** (`claude -p "<prompt>" --output-format stream-json` / headless) or **Codex** (`codex exec`) in print/headless mode; stream stdout back. Detect availability; surface clear errors if the CLI isn't installed.
- Provider + model selection in Settings; **secure key storage** via the OS keychain (`safeStorage` / keytar), never plaintext on disk, never logged.

### Read-only transcript context
- The provider receives the transcript as **input context only**. There is **no API, IPC, or tool** exposed to any provider that can write/patch transcript files or `meta.json`. This is a structural guarantee, not a prompt instruction.
- Context strategy: for normal meetings, pass the full transcript; for very long ones, fall back to **chunk + retrieve** (simple local embedding/keyword retrieval) — documented threshold.

### Chat UI (renderer)
- In-call chat panel: streaming responses, message history per meeting, "thinking"/error states, copy, and a visible indicator of the active provider/model.
- Suggested prompts (e.g. "What action items came up?", "Summarize the last 5 minutes").

## Out of scope
Persisted per-meeting summary generation (PRD-5, which reuses this provider layer). RAG sophistication beyond the documented fallback.

## Acceptance criteria
1. With each of the three providers configured, asking "What action items came up?" mid-meeting returns a grounded answer referencing actual transcript content, streamed token-by-token.
2. **Invariant test**: an automated test asserts no provider/chat code path can mutate `transcript.live.md`, the structured transcript, or `meta.json` (e.g. the provider module has no write access / the only file APIs it can reach are read-only).
3. Switching providers in Settings takes effect without restart.
4. API keys are stored in the OS keychain and never appear in logs or on disk in plaintext.
5. Missing Ollama / un-installed CLI produces an actionable error, not a crash.

## Notes for implementers
- Keep the provider interface minimal and identical across backends so PRD-5 can call it for summaries with no special-casing.
- For the CLI provider, stream incrementally and handle non-zero exits + partial output gracefully.
- Treat the read-only guarantee as a reviewable architectural boundary: providers depend on a read-only transcript accessor with no write counterpart in scope.
