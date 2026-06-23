# PRD-8 — Packaging + Custom GitHub Auto-Updater (Works **Unsigned**)

## Goal
Ship installable macOS + Windows apps that **constantly check GitHub and self-update with no code-signing certificate**: a routine checks GitHub for the latest release; if the running version is behind, it downloads the new one, switches to it, relaunches, and deletes the old version.

## Background
`electron-updater` / Squirrel.Mac **refuse to apply updates to unsigned apps on macOS** (the "app is damaged" failure), so the built-in updater is a non-starter for our unsigned-first requirement. We build a **custom updater** instead, using one unified mechanism on both OSes. Integrity is guaranteed by **sha256** (standing in for a code signature). Adding certs later removes only the one-time first-launch approval and enables notarization — the updater code is unchanged.

## Scope / deliverables

### Bundling
- Bundle the **Python sidecar** and **MCP server** as the app's runtime: PyInstaller onedir (or python-build-standalone + uv). Resolve bundled-binary paths in the main-process supervisor (PRD-0).
- **Models download on first run** (faster-whisper needs no torch; pyannote/torch fetched on first diarization) to keep the installer lean.
- `electron-builder` produces, per platform:
  - **Update-channel artifacts** (consumed by the self-updater): a **zipped `.app`** (macOS, per-arch) and a **portable zip** (Windows). Zip/folder self-replaces far more easily than DMG/NSIS.
  - Optional **DMG / NSIS** for first-time human download.

### Update feed (GitHub Releases)
- Each release includes a small **`version.json`** manifest asset:
  ```json
  {
    "version": "1.2.3",
    "notes": "…",
    "platforms": {
      "darwin-arm64": { "url": "…/Loqui-1.2.3-arm64-mac.zip", "sha256": "…", "size": 0 },
      "darwin-x64":   { "url": "…", "sha256": "…", "size": 0 },
      "win32-x64":    { "url": "…/Loqui-1.2.3-win.zip",       "sha256": "…", "size": 0 }
    }
  }
  ```
- The app fetches the **latest** release's manifest (public repo, unauthenticated — 60 req/hr is ample) **on launch + on a configurable interval (~30 min)**.

### Updater core (`apps/desktop/src/updater/`)
1. Fetch manifest → **semver-compare** against the running version.
2. If newer: download the platform asset to a staging dir via Node `https`/`fetch` — **critically this avoids the `com.apple.quarantine` attribute** that browser downloads get. Show a non-blocking "Update ready — restart to apply" prompt (and a "check now" action).
3. **Verify sha256** before touching anything; abort on mismatch.
4. Extract the zip to staging, spawn a **detached** OS helper (`child_process.spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()`), then quit the app.

### macOS helper (`build-helpers/update-helper.sh`)
- Wait for the parent PID to exit → `rm -rf` the old `.app` (located by walking up from `app.getPath('exe')`) → move the new `.app` into place → `xattr -dr com.apple.quarantine "<App>.app"` → **`codesign --force --deep --sign - "<App>.app"`** (ad-hoc sign, so Gatekeeper relaunches it cleanly without the "damaged" error) → `open "<App>.app"`.

### Windows helper (`build-helpers/update-helper.ps1`)
- Wait for the parent PID to exit → replace the app folder/exe → relaunch with `Start-Process`. (SmartScreen may warn on unsigned but does not hard-block.)

### Release automation (`.github/workflows/release.yml`)
- On tag `v*`: build per-platform artifacts, compute sha256s, generate `version.json`, and publish the GitHub Release with all assets.

### Settings / UX
- Show current version, last-checked time, "Check for updates now", and update-available/restart prompts. Interval configurable; auto-check on by default.
- A `SIGNING.md` documenting how to plug in an Apple Developer ID + Windows cert later (removes the first-launch prompt, enables notarization) with **no updater code changes**.

## Honest first-launch caveat
Unsigned apps still need a **one-time manual approval** on first install (macOS "Open Anyway" / Windows SmartScreen "Run anyway"). Every self-update **after** that relaunches without prompts thanks to the quarantine-strip + ad-hoc sign.

## Acceptance criteria (testable now, no cert)
1. On a clean **Mac** and **Windows** machine, install the app (one-time approval) and it runs (sidecar launches, models download on first use).
2. Bump the version and publish a newer GitHub release with a valid `version.json`; within the poll interval the app **detects** it, **downloads + sha256-verifies** it, **swaps** the bundle, **relaunches into the new version**, and the **old version is gone** — with **no signing certificate**.
3. sha256 mismatch aborts the update safely (old version intact).
4. "Check for updates now" works on demand; no-update case is a no-op.
5. A staged end-to-end test (publish vN → vN+1, observe in-place upgrade) passes on both OSes.

## Notes for implementers
- The "download via Node, not the browser" detail is load-bearing on macOS (no quarantine attr) — don't shell out to a browser/`open` for the download.
- Ad-hoc signing (`codesign --sign -`) is what makes the swapped unsigned bundle relaunch reliably; keep it in the helper, not the parent (the parent is gone by then).
- Keep the updater resilient to offline / rate-limit / partial-download (resume or restart cleanly; never leave a half-swapped app).
