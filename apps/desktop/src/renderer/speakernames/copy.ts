/**
 * PRD-6 — renderer-side copy + presentation mapping for the speaker-name
 * capture indicator.
 *
 * The browser extension that reads Google Meet's participant list is the
 * MOST FRAGILE part of Loqui (Meet's DOM changes without notice), so this
 * indicator's #1 job is to make "not connected" feel normal, not broken: every
 * disconnected/idle state explicitly reassures the user that diarization (the
 * generic `Speaker N` transcript) still works WITHOUT the extension.
 *
 * Pure + presentational ONLY — no I/O, no window.loqui, no React. It turns a
 * {@link SpeakerNamesStatus} into the strings + the status-pill modifier the
 * component renders. Kept separate from the component so the messaging is unit
 * testable on its own and the install guidance lives in one place.
 */
import type { SpeakerNamesStatus, SpeakerNamesConnState } from "@loqui/shared";

/**
 * Maps each connection/capture state to the renderer's `status--*` pill
 * modifier class (reusing the shared sidecar-status pill styling):
 *   - `capturing`    -> connected/green: names are flowing for the active meeting.
 *   - `connected`    -> connecting/amber: extension is paired but not capturing
 *                       (no active meeting, or the Meet tab is idle).
 *   - `disconnected` -> disconnected/slate: no extension — the NORMAL resting
 *                       state, not an error.
 */
export const SPEAKERNAMES_STATE_MODIFIER: Record<
  SpeakerNamesConnState,
  "connected" | "connecting" | "disconnected"
> = {
  capturing: "connected",
  connected: "connecting",
  disconnected: "disconnected",
};

/** Short label shown inside the status pill, per state. */
export const SPEAKERNAMES_STATE_LABEL: Record<SpeakerNamesConnState, string> = {
  capturing: "Capturing names",
  connected: "Extension connected",
  disconnected: "Extension not connected",
};

/**
 * The reassurance/explainer line shown under the pill. EVERY state restates that
 * diarization works regardless — that invariant is the whole point of this UI.
 */
export const SPEAKERNAMES_STATE_DETAIL: Record<SpeakerNamesConnState, string> = {
  capturing:
    "Reading participant names from Google Meet for this meeting. After the call, matching speakers get their real names; anything uncertain stays a generic “Speaker N”.",
  connected:
    "The Meet helper is connected but not capturing yet — it starts once a meeting is recording in a Google Meet tab. Diarization works either way; without captured names, speakers are labeled “Speaker N”.",
  disconnected:
    "No Meet helper detected. This is fine — Loqui still records, transcribes, and diarizes your meeting; speakers are simply labeled “Speaker N” instead of by name.",
};

/** Presentation derived from a status, ready for the component to render. */
export interface SpeakerNamesPresentation {
  state: SpeakerNamesConnState;
  modifier: "connected" | "connecting" | "disconnected";
  label: string;
  detail: string;
  /** Whether to show the one-time install/pairing guidance (only when no extension). */
  showInstallGuidance: boolean;
}

/**
 * Pure derivation of everything the indicator renders from a status. Tolerates a
 * partial/unknown status (graceful degradation): an unrecognized state falls
 * back to `disconnected` so the UI never breaks on a forward-incompatible push.
 */
export function presentSpeakerNamesStatus(
  status: SpeakerNamesStatus,
): SpeakerNamesPresentation {
  const state: SpeakerNamesConnState =
    status.state in SPEAKERNAMES_STATE_LABEL ? status.state : "disconnected";
  return {
    state,
    modifier: SPEAKERNAMES_STATE_MODIFIER[state],
    label: SPEAKERNAMES_STATE_LABEL[state],
    detail: SPEAKERNAMES_STATE_DETAIL[state],
    // Guidance is for users who haven't paired the extension; once it's
    // connected/capturing there's nothing to install.
    showInstallGuidance: state === "disconnected",
  };
}

/** A "nothing connected" status — the all-defaults resting value. */
export const SPEAKERNAMES_DISCONNECTED: SpeakerNamesStatus = {
  state: "disconnected",
  meetingActive: false,
  bufferedEvents: 0,
  lastEventAt: null,
  selectorVersion: "",
  extensionVersion: "",
};

/**
 * One-time install / pairing guidance steps shown when no extension is detected.
 * Intentionally tool-agnostic and short: install the Loqui Meet helper, open a
 * Google Meet, and the indicator flips to "capturing" on its own. The extension
 * dials the loopback WS server automatically — there is no key/port to enter.
 */
export const SPEAKERNAMES_INSTALL_STEPS: ReadonlyArray<string> = [
  "Install the Loqui browser helper for Google Meet (one time).",
  "Open or join a meeting at meet.google.com in that browser.",
  "Start recording in Loqui — this indicator turns green when names are being captured.",
];
