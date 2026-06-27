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
  echo "update-helper: no .app found in staged path $STAGED_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_PATH")"

# 2. Replace the old bundle with the new one, keeping the old app restorable
#    until the new bundle is in place.
OLD_ASIDE="$INSTALL_PATH.old-$$"
mv "$INSTALL_PATH" "$OLD_ASIDE"
if ! mv "$NEW_APP" "$INSTALL_PATH"; then
  echo "update-helper: failed to move new app into place; restoring old app" >&2
  mv "$OLD_ASIDE" "$INSTALL_PATH"
  exit 1
fi
rm -rf "$OLD_ASIDE"

# 3. Strip quarantine + ad-hoc sign so Gatekeeper relaunches the unsigned app.
/usr/bin/xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - "$INSTALL_PATH" 2>/dev/null || true

# 4. Relaunch the new version.
TARGET="$RELAUNCH_TARGET"
if [ ! -d "$TARGET" ] && [ ! -f "$TARGET" ]; then
  TARGET="$INSTALL_PATH"
fi
/usr/bin/open "$TARGET" || true
exit 0
