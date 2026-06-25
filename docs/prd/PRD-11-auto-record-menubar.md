# PRD-11 — Auto-Record on Meeting Detection + Menubar/Tray

## Goal
Automatically start recording when the user joins a meeting and stop when it ends, and run as an unobtrusive **menubar/tray** app — matching a comparable local app's auto-record UX while also covering **browser-based meetings** (which a comparable local app explicitly cannot detect).

## Background (competitive)
A comparable local app auto-starts when a native conferencing app (Zoom/Teams/Slack/FaceTime/Webex/Discord/Meet/Loom) is running + the mic is active, auto-stops ~5s after the call ends, supports a configurable silence auto-stop, and lives in the menubar. It cannot detect browser meetings. Loqui requires manual start/stop and is a windowed app. This PRD adds auto-record + a tray presence; combined with the PRD-6 Google Meet browser extension, Loqui detects **both** native and browser meetings.

## Scope / deliverables
- **Meeting detection** (cross-platform, best-effort):
  - Native conferencing app running + actively using the microphone/audio (macOS: running apps + mic-in-use signal; Windows: process + audio-session enumeration via WASAPI). Configurable app allowlist.
  - **Browser meetings** via the PRD-6 extension signal (a Meet/Zoom/Teams web tab is in a call) over the existing local WebSocket.
- **Auto-record policy**: on detection → prompt-or-auto-start (configurable: "ask" vs "auto"); on meeting end → auto-stop after a configurable delay; **silence auto-stop** with a configurable timeout + countdown. A clear recording indicator (tray icon state + window badge).
- **Menubar/tray app**: tray icon with quick controls (start/stop, open, status, recent meetings), optional "run in background / no dock icon" mode, launch-at-login option. The main window remains available.
- All policies are settings with sensible defaults; auto-record can be fully disabled (manual-only) to preserve the current behavior.

## Out of scope
The capture mechanism itself (PRD-1) and the Meet extension (PRD-6) — this PRD consumes their signals. Process-specific audio *filtering* is PRD-13.

## Acceptance criteria
1. With auto-record enabled, starting a Zoom/Teams/etc. call (native) **and** a Google Meet call (browser, via the extension) both trigger recording per policy; ending the call auto-stops after the configured delay.
2. Silence auto-stop ends a meeting after the configured idle timeout, with a visible countdown.
3. The app runs from the tray/menubar with working quick controls and a recording-state indicator; launch-at-login works.
4. Auto-record can be disabled → manual start/stop (PRD-3 behavior) is unchanged.
5. Hermetic tests: detection state machine (app-active × mic-active × extension-signal → start/stop decisions) with mocked OS/extension inputs; silence-stop timer; tray menu actions (mocked). Real OS detection is manual-verified.
6. PRD-0..10 stay green.

## Notes for implementers
- Detection is inherently OS-specific and best-effort — keep it behind a small platform-abstracted detector with a deterministic, unit-testable decision core; never let a detection miss block manual control.
- Reuse the PRD-6 WS server for the browser signal; reuse the PRD-3 lifecycle for start/stop.
- Native auto-record must remain inert until a real mic-in-use probe lands (Windows CapabilityAccessManager ConsentStore / WASAPI, macOS CoreAudio "device in use"); do not infer mic activity from process presence.
