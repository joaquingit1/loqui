# AGENTS.md — environment rules for AI agents working in this repo (Windows dev box)

This monorepo is macOS-primary but is being developed on **Windows 11**. Follow these
rules to avoid the recurring failure modes:

## Encoding (prevents patch/"mojibake" failures)
- Many `sidecar/loqui_sidecar/**/*.py` and `packages/shared/src/*.ts` files contain
  **non-ASCII** characters in docstrings/comments (em dashes `—`, arrows `→`). Always
  read/write files as **UTF-8**. Prefer structured patch/edit tools over PowerShell
  `Get-Content`/`Set-Content` (PS 5.1 defaults to non-UTF-8 and corrupts these chars).
  If you must use PowerShell to write a file, pass `-Encoding utf8`.
- Make **minimal, targeted edits**; do not rewrite whole docstrings.

## Node / native module (prevents better-sqlite3 build failure)
- System Node is v24 and there is **no MSVC compiler** here, so `better-sqlite3`
  (used by `apps/desktop` + `mcp-server`) will not compile. A portable **Node 22**
  with a prebuilt binary is used for all JS/pnpm commands. Put it on PATH and set
  `COREPACK_INTEGRITY_KEYS=0` before any `pnpm` command (see the session ENV note).
- **Do NOT run `pnpm install` / `pnpm rebuild`** (recompiles the native module under
  the wrong Node and breaks it). `uv sync` for the Python sidecar is fine.
- `@loqui/shared` is consumed as its built **dist** — after editing
  `packages/shared/src`, run `corepack pnpm --filter @loqui/shared build` before
  typechecking dependents.

## Python / uv
- `UV_CACHE_DIR` is set to a writable dir in agent configs; the default
  `%LOCALAPPDATA%\uv\cache` is not writable from sandboxes ("access-denied").

## Gate (hermetic — temp data dir, no network, no real models)
```
(cd sidecar && uv run pytest -q && uv run ruff check . && uv run black --check .)
corepack pnpm --filter @loqui/shared build && corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test
```
A pre-existing `mcp-server` `require.resolve("tsx/cli")` vitest failure is a missing
devDependency (tracked separately), not caused by feature work.

## Invariants (never violate)
1. The AI never edits the transcript (diarization/summary write only derived files).
2. Local-first: nothing leaves the machine except an explicitly configured cloud
   provider / calendar.
3. The two audio streams (You/mic, They/system) stay separate end to end.
4. Cross-platform macOS 13+ / Windows 10+, CPU-only (no NVIDIA-GPU-only deps).
5. Cross-process shapes live in `packages/shared` (zod) and are mirrored by the
   Python sidecar (camelCase on the wire).
