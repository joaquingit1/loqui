# PRD-7 — Local MCP Server (Agent-Queryable Meeting Memory)

## Goal
Expose Loqui's local meeting store over the **Model Context Protocol** so the user's *own* AI agent (Claude Code, Codex, Claude Desktop) can search past meetings and fetch transcripts/summaries on demand — "an MCP that connects to your local software instead of a cloud account." Read-only.

## Background
This is a top-priority differentiator and far more robust than the Google Meet DOM scraping, so it's built **before** PRD-6. It reuses the SQLite/FTS index (PRD-0/PRD-3) and the meeting files — it does not re-implement storage.

## Scope / deliverables

### MCP server (`mcp-server/`)
- Built on the official MCP SDK. **Read-only** over `~/Loqui` (no tool can write/modify meetings).
- **Transports**: `stdio` (for Claude Code / Claude Desktop / Codex config) and an optional local **HTTP/SSE** transport bound to loopback.
- **Tools**:
  - `list_meetings({ from?, to?, query?, limit? })` → meetings by date range / title match (most recent first).
  - `search_meetings({ query, limit? })` → FTS across transcripts **and** summaries; returns matches with snippets + meeting refs.
  - `get_meeting({ id })` → metadata (title, date, participants, status, speakers).
  - `get_transcript({ id, variant?: "live" | "diarized" })` → transcript text (diarized when available, else live).
  - `get_summary({ id })` → the meeting summary.
- Resources/prompts as helpful (e.g. a `meeting://<id>` resource); date inputs accept natural ranges resolved by the caller (document the format).

### Lifecycle & config
- Runnable **standalone** (`loqui-mcp`) and **managed by the app** (start/stop from Settings, status indicator).
- Settings screen prints ready-to-paste config snippets for **Claude Code** (`claude mcp add` / JSON), **Claude Desktop**, and **Codex**, pointing at the local server.
- Respects the same data root as the app; safe when the app isn't running (reads files/db directly).

## Out of scope
Writing/editing meetings via MCP (explicitly disallowed). Remote/network exposure beyond loopback.

## Acceptance criteria
1. Adding the printed config to **Claude Code** makes Loqui's tools available; asking "What did we decide in last Tuesday's meeting?" drives `search_meetings` → `get_transcript`/`get_summary` and returns **real content** from the local store.
2. `list_meetings` with a date range returns the correct meetings in date order.
3. `search_meetings` finds a keyword across both transcripts and summaries with usable snippets.
4. The server works when launched standalone (app closed) and when managed by the app.
5. **No** tool can modify any meeting (verified by tool surface + a write-attempt test that has no available path).
6. Tests: each tool against a seeded store; transport smoke test (stdio).

## Notes for implementers
- Reuse PRD-3 store/index query functions; the MCP server is a thin read-only adapter over them.
- Keep tool schemas tight and well-described (the agent picks tools from descriptions). Return compact, citation-friendly results (ids + timestamps) so the agent can fetch detail.
