#!/bin/bash
#
# PRD-8 — macOS self-update helper.
#
# Invoked DETACHED by the app right before it quits (see
# apps/desktop/src/main/updater/helper.ts -> resolveHelperPlan). It:
#   1. Waits for the parent PID (the quitting app) to fully exit so the .app is
#      not in use when we replace it.
#   2. Moves the old <App>.app aside and moves the new one into place.
#   3. Strips the com.apple.quarantine xattr (the download already avoided it by
#      using Node https rather than a browser, but we strip defensively) and
#      AD-HOC code-signs the new bundle (codesign --force --deep --sign -). The
#      ad-hoc signature is what makes Gatekeeper relaunch an UNSIGNED app cleanly
#      WITHOUT the "app is damaged" error — this is the load-bearing step that
#      lets the unsigned self-updater work. It lives HERE (not in the parent),
#      because by swap time the parent is already gone.
#   4. Relaunches the new app via `open` and exits.
#
# Adding a real Developer ID + notarization later makes the quarantine-strip +
# ad-hoc-sign a harmless no-op — NO change to this helper or the updater code
# is required.
#
# Positional args (from the app):
#   $1 ParentPid       the app PID to wait on before swapping
#   $2 StagedPath      the extracted new-version tree (contains <App>.app)
#   $3 InstallPath     the installed <App>.app bundle to replace
#   $4 RelaunchTarget  the .app to `open` after the swap (usually == InstallPath)
set -euo pipefail

PARENT_PID="${1:?parent pid required}"
STAGED_PATH="${2:?staged path required}"
INSTALL_PATH="${3:?install path required}"
RELAUNCH_TARGET="${4:?relaunch target required}"

# Durable log: the app spawns us detached with stdio ignored, so stderr is
# discarded. Mirror every diagnostic to a log file next to the installed app so a
# failed swap/re-sign is inspectable after the fact. Best-effort — a log-write
# failure must never abort the swap.
LOG_FILE="$(dirname "$INSTALL_PATH")/loqui-update-helper.log"
log() {
  echo "update-helper: $*" >&2
  echo "$(date '+%Y-%m-%dT%H:%M:%S') update-helper: $*" >>"$LOG_FILE" 2>/dev/null || true
}

# 1. Wait (bounded) for the parent app to exit so the bundle is free.
deadline=$(( $(date +%s) + 60 ))
while kill -0 "$PARENT_PID" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    break
  fi
  sleep 0.2
done
# Short settle for file handles to drop.
sleep 0.3

# Locate the new .app inside the staged tree (the zip contains <App>.app at root).
NEW_APP=""
if [[ "$STAGED_PATH" == *.app ]]; then
  NEW_APP="$STAGED_PATH"
else
  # First top-level *.app under the staged tree.
  NEW_APP="$(/usr/bin/find "$STAGED_PATH" -maxdepth 2 -name '*.app' -type d | head -n 1)"
fi
if [ -z "$NEW_APP" ] || [ ! -d "$NEW_APP" ]; then
  log "no .app found in staged path $STAGED_PATH"
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_PATH")"

# 2. Replace the old bundle with the new one, keeping the old app restorable
#    until the new bundle is in place.
OLD_ASIDE="$INSTALL_PATH.old-$$"
mv "$INSTALL_PATH" "$OLD_ASIDE"
if ! mv "$NEW_APP" "$INSTALL_PATH"; then
  log "failed to move new app into place; restoring old app"
  mv "$OLD_ASIDE" "$INSTALL_PATH"
  exit 1
fi
rm -rf "$OLD_ASIDE"

# 3. Strip quarantine + code-sign so Gatekeeper relaunches the app cleanly.
#
#    Prefer a STABLE signing identity ("Loqui Local Dev") when it exists in the
#    keychain: an ad-hoc signature (`--sign -`) mints a NEW code identity on every
#    self-update, and macOS keys the Screen Recording + keychain (safeStorage)
#    grants to the code identity — so re-signing ad-hoc on each update DROPS those
#    grants and re-prompts the user. Signing with the persistent "Loqui Local Dev"
#    cert keeps the identity constant across updates, preserving the grants. If
#    that cert isn't present, fall back to ad-hoc (still lets an unsigned build
#    relaunch without the "app is damaged" error).
#
#    Sign INSIDE-OUT: the bundled ScreenCaptureKit helper lives under
#    Contents/Resources/, and `codesign --deep` does NOT sign executables in
#    Resources/ (it only descends into Frameworks/Helpers/PlugIns). So we sign the
#    helper EXPLICITLY first with the same identity, then re-seal the whole app so
#    its CodeResources covers the freshly-signed helper. Without this the helper
#    keeps its old (possibly ad-hoc, mismatched) signature after a self-update,
#    which breaks the Screen Recording grant that macOS attributes by code
#    identity. Mirrors the packaging afterPack hook (apps/desktop/build/after-pack.cjs).
#
#    We do NOT swallow the codesign exit code: a failure is logged to the durable
#    log and the swap continues (a failed re-sign must not abort the update — the
#    app is already in place).
/usr/bin/xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
if /usr/bin/security find-certificate -c "Loqui Local Dev" >/dev/null 2>&1; then
  SIGN_IDENTITY="Loqui Local Dev"
else
  SIGN_IDENTITY="-"
fi
HELPER_PATH="$INSTALL_PATH/Contents/Resources/native/loqui-asr-helper"
if [ -f "$HELPER_PATH" ]; then
  if /usr/bin/codesign --force --options runtime --sign "$SIGN_IDENTITY" "$HELPER_PATH" 2>/dev/null; then
    log "code-signed helper with identity '$SIGN_IDENTITY'"
  else
    log "codesign FAILED for helper (identity '$SIGN_IDENTITY'); continuing with the swap anyway"
  fi
else
  log "helper not found at $HELPER_PATH; skipping helper re-sign"
fi
# The APP re-seal deliberately OMITS `--options runtime`: hardened runtime blocks
# Electron/V8's JIT without allow-jit entitlements (we ship none; the build sets
# hardenedRuntime: false). Only the Swift helper above gets the flag.
if /usr/bin/codesign --force --deep --sign "$SIGN_IDENTITY" "$INSTALL_PATH" 2>/dev/null; then
  log "code-signed app bundle with identity '$SIGN_IDENTITY'"
else
  log "codesign FAILED (identity '$SIGN_IDENTITY'); continuing with the swap anyway"
fi

# 4. Relaunch the new version.
TARGET="$RELAUNCH_TARGET"
if [ ! -d "$TARGET" ] && [ ! -f "$TARGET" ]; then
  TARGET="$INSTALL_PATH"
fi
/usr/bin/open "$TARGET" || true
exit 0
