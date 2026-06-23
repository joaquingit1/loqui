/**
 * Pure renderer-side meeting-lifecycle model (PRD-3).
 *
 * The backend `Meeting.status` is the source of truth ("recording" | "processing"
 * | "done" | "error"), but the RENDERER needs a slightly richer phase machine to
 * cover the in-flight client states that have no server status yet — the moment
 * between clicking Start and the `startMeeting` promise resolving ("starting"),
 * and the moment between clicking Stop and `stopMeeting` resolving ("stopping").
 *
 * This module is pure (no React, no window.loqui) so the transitions are unit
 * testable in isolation; {@link useMeetingController} folds real lifecycle events
 * into it.
 */
import type { Meeting, MeetingStatus } from "@loqui/shared";

/**
 * The renderer lifecycle phase. A superset of {@link MeetingStatus}:
 *   - `idle`       — no meeting in flight (initial / after a finished meeting is dismissed)
 *   - `starting`   — Start clicked; `startMeeting` (and capture start) in flight
 *   - `recording`  — meeting live, capture running (server status "recording")
 *   - `stopping`   — Stop clicked; capture teardown + `stopMeeting` in flight
 *   - `processing` — server is post-processing the finished meeting
 *   - `done`       — meeting finalized and browsable
 *   - `error`      — start/stop/capture failed, or the server reported "error"
 */
export type MeetingPhase =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "processing"
  | "done"
  | "error";

/** Immutable snapshot the controller exposes to the UI. */
export interface MeetingControllerState {
  phase: MeetingPhase;
  /** The active or most-recently-finished meeting; null before the first start. */
  meeting: Meeting | null;
  /** Human-readable failure message; set iff `phase === "error"`. */
  error: string | null;
}

export const initialMeetingState: MeetingControllerState = {
  phase: "idle",
  meeting: null,
  error: null,
};

/** Phases in which a meeting is actively capturing audio. */
export function isRecordingPhase(phase: MeetingPhase): boolean {
  return phase === "recording";
}

/** Phases in which Start is the available action (no meeting in flight). */
export function canStart(phase: MeetingPhase): boolean {
  return phase === "idle" || phase === "done" || phase === "error";
}

/** Phases in which Stop is the available action (a meeting is live). */
export function canStop(phase: MeetingPhase): boolean {
  return phase === "recording";
}

/**
 * Map a backend {@link MeetingStatus} (carried by an `onMeetingStatus` push or a
 * resolved start/stop promise) to the renderer {@link MeetingPhase}. The in-flight
 * client phases (`starting`/`stopping`) are NOT produced here — they are set by
 * the controller around the awaited calls.
 */
export function phaseFromStatus(status: MeetingStatus): MeetingPhase {
  switch (status) {
    case "recording":
      return "recording";
    case "processing":
      return "processing";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/**
 * Fold an authoritative backend status event for `meeting` into the current
 * state. Only applies when the event concerns the meeting we're tracking (by id)
 * — a stale event for a previous meeting is ignored. An in-flight `stopping`
 * phase is preserved until the server moves past `recording` (so the Stop
 * button doesn't flicker back to "Stop" if a final "recording" push races the
 * stop call).
 */
export function applyStatusEvent(
  state: MeetingControllerState,
  meeting: Meeting,
): MeetingControllerState {
  if (state.meeting && meeting.id !== state.meeting.id) return state;

  const next = phaseFromStatus(meeting.status);

  // While we're tearing down locally, ignore a lingering "recording" echo.
  if (state.phase === "stopping" && next === "recording") {
    return { ...state, meeting };
  }

  return {
    phase: next,
    meeting,
    error: next === "error" ? (state.error ?? "Meeting ended with an error.") : null,
  };
}
