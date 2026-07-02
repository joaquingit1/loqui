// PRD-8 / macOS code-signing durability — electron-builder afterPack hook.
//
// WHY this exists: `codesign --deep` only signs NESTED code in the standard
// bundle locations (Frameworks/, Helpers/, PlugIns/, MacOS/). It DOES NOT sign
// executables that live under Contents/Resources/. We ship the ScreenCaptureKit
// helper at Contents/Resources/native/loqui-asr-helper, so electron-builder's
// own signing (and any `--deep` re-seal) leaves the helper with whatever
// signature it was built with — typically an AD-HOC identity whose identifier
// (`loqui-asr-helper`) differs from the app (`app.loqui.desktop`). macOS keys
// the Screen Recording (TCC) grant to code identity, so a mismatched/ad-hoc
// helper identity that drifts on every build breaks TCC attribution and makes
// the "They" (system-audio) grant non-durable.
//
// FIX: after packaging, sign INSIDE-OUT with the SAME identity as the app —
// helper first, then re-seal the whole app so its CodeResources seal covers the
// freshly-signed helper (touching a Resources/ file invalidates the app seal).
// Prefer the stable "Loqui Local Dev" cert when it's in the keychain (keeps the
// identity constant across builds so grants persist); fall back to ad-hoc `-`
// so CI / public unsigned builds still work. Mirrors update-helper.sh, which
// applies the same inside-out signing after a self-update swap.
//
// A codesign failure is logged but never thrown: a failed re-sign must not abort
// packaging (same policy as the update helper).

const path = require("path");
const { execFileSync } = require("child_process");

const LOG_PREFIX = "[after-pack]";

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

/**
 * Resolve the signing identity: prefer the stable self-signed "Loqui Local Dev"
 * cert when present in the keychain, else fall back to ad-hoc (`-`).
 */
function resolveIdentity() {
  try {
    execFileSync("security", ["find-certificate", "-c", "Loqui Local Dev"], {
      stdio: "ignore",
    });
    return "Loqui Local Dev";
  } catch {
    return "-";
  }
}

/**
 * codesign a single target with the given identity. Logs and continues on
 * failure (a failed re-sign must not abort packaging).
 */
function sign(identity, target) {
  try {
    execFileSync(
      "codesign",
      ["--force", "--options", "runtime", "--sign", identity, target],
      { stdio: "inherit" },
    );
    log(`signed ${target} with identity '${identity}'`);
  } catch (err) {
    log(`codesign FAILED for ${target} (identity '${identity}'): ${err.message}`);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const helperPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "native",
    "loqui-asr-helper",
  );

  const fs = require("fs");
  if (!fs.existsSync(helperPath)) {
    log(`helper not found at ${helperPath}; skipping helper re-sign`);
    return;
  }

  const identity = resolveIdentity();
  log(`using signing identity '${identity}' for ${appName}`);

  // Inside-out: 1) sign the Resources/ helper (which `--deep` skips), then
  // 2) re-seal the whole app so CodeResources covers the newly-signed helper.
  //
  // The APP re-seal deliberately OMITS `--options runtime`: hardened runtime
  // blocks Electron/V8's JIT (writable+executable memory) without allow-jit
  // entitlements, which we don't ship (the yml sets hardenedRuntime: false).
  // Only the Swift helper (no JIT) gets the flag — harmless there and
  // notarization-friendly.
  sign(identity, helperPath);
  try {
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", identity, appPath],
      { stdio: "inherit" },
    );
    log(`re-sealed app bundle ${appName} with identity '${identity}'`);
  } catch (err) {
    log(`codesign FAILED for ${appName} (identity '${identity}'): ${err.message}`);
  }

  // Verify the seal (informational only — do not throw on a verify failure).
  try {
    execFileSync("codesign", ["--verify", "--strict", "--deep", appPath], {
      stdio: "inherit",
    });
    log(`codesign --verify --strict --deep passed for ${appName}`);
  } catch (err) {
    log(`codesign --verify FAILED for ${appName}: ${err.message}`);
  }
};
