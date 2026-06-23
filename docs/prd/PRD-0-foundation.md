# PRD-0 — Foundation, Contracts & Scaffolding

## Goal
A runnable Electron shell and Python sidecar that talk to each other over a defined protocol, with the shared schemas, storage layer, and CI that every later PRD builds on. After this PRD, `pnpm dev` launches the app, spawns and health-checks the sidecar, and can create/read a meeting in the store.

## Background
Loqui is an Electron app (Node main + React renderer) plus a long-running **Python sidecar** that does all ML/audio-heavy work. The two communicate over a local connection. This PRD establishes the contracts (so later PRDs can be built in parallel against stable interfaces), the process supervision, and the on-disk meeting store.

## Scope / deliverables

### Monorepo tooling
- pnpm workspaces wired (root `package.json`, `pnpm-workspace.yaml` already scaffolded).
- TypeScript project references across `apps/desktop`, `packages/shared`, `packages/audio`, `mcp-server`.
- Linting/formatting: ESLint + Prettier (TS), ruff + black (Python).
- Python managed with **uv** (`sidecar/pyproject.toml`); Python ≥ 3.11.
- Each workspace exposes `build`, `lint`, `typecheck`, `test` scripts.

### Electron shell (`apps/desktop`)
- Main process (`src/main/`), preload (`src/preload/` with `contextBridge`, `contextIsolation: true`, `nodeIntegration: false`), renderer (`src/renderer/`, React + Vite).
- A minimal window that renders a "Loqui" home screen and a sidecar-status indicator.
- Build via `electron-vite` (or equivalent); `pnpm --filter @loqui/desktop dev` runs it.

### Python sidecar skeleton (`sidecar/`)
- FastAPI app + a WebSocket endpoint, started by a `loqui-sidecar` console entrypoint.
- `GET /health` returns `{status, version, models: {...}}`.
- Binds to `127.0.0.1` on an **ephemeral port**; prints the chosen port + an auth token as the first line of stdout (so the main process can read and connect). Never expose beyond loopback.
- Graceful shutdown on SIGTERM and on parent-exit detection.

### Shared contract (`packages/shared`) — single source of truth
Define these (TS types + zod schemas; emit JSON Schema so the sidecar can validate):

- **Handshake / control** (main ↔ sidecar JSON-RPC-ish over WS): `ping`/`pong`, `getHealth`, `shutdown`.
- **Meeting schema** (`Meeting`): `id` (uuid), `title`, `platform` (`"google-meet" | "zoom" | "teams" | "other" | null`), `startedAt`/`endedAt` (ISO 8601), `status` (`"recording" | "processing" | "done" | "error"`), `participants` (array), `modelVersions` (object), `createdAt`/`updatedAt`.
- **Audio stream protocol**: a control frame `audioStart {meetingId, source: "mic" | "system", sampleRate: 16000, channels: 1, encoding: "pcm_s16le"}`, binary PCM frames tagged by source, and `audioStop {meetingId, source}`.
- **Transcript segment events** (sidecar → main → renderer): `TranscriptSegment { meetingId, source: "mic" | "system", text, tStart, tEnd, status: "partial" | "final", segId }`.
- **Job events**: `JobUpdate { jobId, kind: "transcription" | "diarization" | "summary", state, progress, error? }`.
- A versioned `PROTOCOL_VERSION` constant; handshake fails loudly on mismatch.

### Sidecar supervisor (main process)
- Locate the sidecar (dev: `uv run`; packaged: bundled binary path).
- Spawn, read the port/token handshake line, connect WS, health-check.
- Restart with backoff on crash; surface status to the renderer; clean shutdown on app quit.

### Storage layer (`apps/desktop/src/main/store/` or `packages/shared` helper)
- Resolve data root: `~/Loqui/` (configurable). Per-meeting dir `~/Loqui/meetings/<id>/` with `meta.json`.
- **SQLite index** `~/Loqui/index.db` with an FTS5 virtual table (schema stub for transcripts + summaries; populated by later PRDs). Provide `createMeeting`, `getMeeting`, `listMeetings`, `updateMeeting`.
- Atomic writes (temp-file + rename) for `meta.json`.

### CI (`.github/workflows/ci.yml`)
- On push/PR: install (pnpm + uv), `typecheck`, `lint`, `test` for TS and Python, on macOS + Windows runners.

## Out of scope
Real audio capture, transcription, diarization, chat, MCP, packaging — all later PRDs. Stub their event types in the contract but do not implement.

## Acceptance criteria
1. `pnpm install && pnpm dev` launches the app on macOS and Windows; the window shows a green "sidecar connected" status.
2. A `ping` from the renderer round-trips through main → sidecar → back, displayed in a debug panel.
3. The contract types compile and are imported by both `apps/desktop` and `mcp-server`; the sidecar validates an incoming frame against the emitted JSON Schema.
4. Creating a dummy meeting writes `~/Loqui/meetings/<id>/meta.json` and a row in `index.db`; `listMeetings` returns it; it survives an app restart.
5. Killing the sidecar process causes the supervisor to restart it and the status indicator to recover.
6. CI is green on both OSes.

## Notes for implementers
- Keep the WS local-only with a per-launch token to prevent other local processes from connecting.
- Prefer `electron-vite` for fast HMR of the renderer.
- The contract is the **stable interface** later PRDs build against in parallel — bias toward completeness here even where the producer/consumer is stubbed.
