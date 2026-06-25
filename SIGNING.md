# Code signing & notarization (optional) — adding certs later with NO updater changes

Loqui ships **unsigned by default** and self-updates over a custom GitHub
updater whose integrity rides on **sha256** (PRD-8). Signing is therefore
**optional**: adding an Apple Developer ID and/or a Windows code-signing
certificate later removes the **one-time first-launch approval** and enables
notarization — **without changing a single line of updater code**.

This document is the runbook for that future step.

---

## Why the updater needs no changes

The updater never depends on a signature to apply an update. It:

1. downloads the new bundle over **Node `https`** (not a browser — so macOS never
   stamps `com.apple.quarantine` on the download),
2. verifies its **sha256** against the release `version.json` **before** touching
   the installed app, and
3. on macOS, the helper **strips quarantine + ad-hoc-signs** the swapped bundle
   (`codesign --force --deep --sign -`) so Gatekeeper relaunches the unsigned app
   cleanly.

When a real Developer ID + notarization are added, the quarantine-strip and
ad-hoc-sign in `build-helpers/update-helper.sh` become **harmless no-ops** (a
properly signed + notarized bundle is already trusted). Nothing in
`apps/desktop/src/main/updater/**` or the helpers needs to change.

---

## macOS — Developer ID + notarization

1. **Obtain a "Developer ID Application" certificate** from your Apple Developer
   account and import it into the CI keychain (or a local keychain for local
   builds).

2. **Point electron-builder at it** (in `apps/desktop/electron-builder.yml`),
   replacing the unsigned `mac:` block's `identity: null`:

   ```yaml
   mac:
     identity: "Developer ID Application: Your Name (TEAMID)"
     hardenedRuntime: true
     gatekeeperAssess: false
     entitlements: build/entitlements.mac.plist
     entitlementsInherit: build/entitlements.mac.plist
     notarize:
       teamId: TEAMID
   ```

3. **Provide notarization credentials** to CI as secrets and env (electron-builder
   reads them):

   ```
   APPLE_ID=...                 # Apple ID email
   APPLE_APP_SPECIFIC_PASSWORD=...   # app-specific password
   APPLE_TEAM_ID=TEAMID
   # or APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER for App Store Connect API keys
   CSC_LINK=...                 # base64 of the .p12 (or a file path)
   CSC_KEY_PASSWORD=...         # the .p12 password
   ```

4. In `.github/workflows/release.yml`, **remove** the
   `CSC_IDENTITY_AUTO_DISCOVERY: "false"` override on the macOS package step and
   pass the secrets above as `env:`.

That's it. The produced `.app` (and the zipped `.app` the updater consumes) is
now signed + notarized; the first-launch "Open Anyway" prompt is gone and every
self-update relaunches silently.

---

## Windows — Authenticode signing

1. **Obtain a code-signing certificate** (OV or, preferably, **EV** — EV builds
   immediate SmartScreen reputation). For an EV cert on a hardware token, use a
   cloud-signing service or a self-hosted runner with the token attached.

2. **Point electron-builder at it** (in the `win:` block):

   ```yaml
   win:
     # File-based cert:
     certificateFile: build/cert.pfx
     certificatePassword: ${env.WIN_CSC_KEY_PASSWORD}
     # …or an Azure Trusted Signing / signtool integration for EV/HSM certs.
     signingHashAlgorithms:
       - sha256
   ```

3. **Provide the cert to CI** as secrets:

   ```
   WIN_CSC_LINK=...            # base64 of the .pfx (or CSC_LINK)
   WIN_CSC_KEY_PASSWORD=...
   ```

4. In `release.yml`, pass those as `env:` on the Windows package step.

Signed Windows builds drop the SmartScreen "unknown publisher" warning (EV: at
once; OV: after reputation accrues). The portable zip the updater swaps in is
signed too, so post-update relaunches are clean.

---

## What still works exactly the same after signing

- The `version.json` feed, the sha256 verification, and the swap+relaunch helpers
  are **unchanged**.
- The updater still downloads via Node `https` (the no-quarantine path is
  belt-and-suspenders even when signed).
- A user mid-migration (older unsigned install → newer signed release) updates
  fine: the unsigned app downloads + verifies + swaps the signed bundle, and the
  helper's ad-hoc-sign is simply redundant on the already-signed `.app`.

---

## Summary

| Platform | Unsigned (today)                          | Signed (later)                         |
| -------- | ----------------------------------------- | -------------------------------------- |
| macOS    | one-time "Open Anyway"; ad-hoc re-sign    | no prompt; notarized; ad-hoc = no-op   |
| Windows  | one-time SmartScreen "Run anyway"         | no/low warning; Authenticode-signed    |

**Updater code changes required to add signing: none.** Only the
`electron-builder.yml` `mac:`/`win:` blocks + the CI secrets/env change.
