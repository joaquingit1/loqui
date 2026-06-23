/**
 * RecordingStatus — the in-meeting lifecycle indicator (PRD-3).
 *
 * Renders a status pill reflecting the renderer {@link MeetingPhase}
 * (idle / starting / recording / stopping / processing / done / error), a live
 * elapsed-time clock while recording (frozen to the final duration once stopped),
 * and an inline error message + recovery hint on failure.
 *
 * Pure presentation: it talks to NO bridge and owns no lifecycle — the phase,
 * meeting, elapsed seconds, and error are passed in. {@link MeetingControls} owns
 * the controller and feeds this.
 */
import type { JSX } from "react";
import type { MeetingPhase } from "../meeting/index.js";
import { formatElapsed } from "../meeting/index.js";

export interface RecordingStatusProps {
  phase: MeetingPhase;
  /** Whole seconds since the meeting started (live while recording). */
  elapsedSeconds: number;
  /** Failure message; shown only when `phase === "error"`. */
  error?: string | null;
}

/** Short human label per phase for the pill. */
const PHASE_LABEL: Record<MeetingPhase, string> = {
  idle: "Not recording",
  starting: "Starting…",
  recording: "Recording",
  stopping: "Stopping…",
  processing: "Processing…",
  done: "Done",
  error: "Error",
};

export function RecordingStatus({
  phase,
  elapsedSeconds,
  error,
}: RecordingStatusProps): JSX.Element {
  const showClock = phase === "recording" || phase === "stopping" || phase === "processing";

  return (
    <div className="meeting-status" data-testid="recording-status" data-phase={phase}>
      <span
        className={`meeting-status__pill meeting-status__pill--${phase}`}
        data-testid="recording-status-pill"
      >
        <span className="meeting-status__dot" aria-hidden="true" />
        {PHASE_LABEL[phase]}
      </span>

      {showClock && (
        <span
          className="meeting-status__clock"
          data-testid="recording-elapsed"
          aria-label="Elapsed recording time"
        >
          {formatElapsed(elapsedSeconds)}
        </span>
      )}

      {phase === "error" && error && (
        <p className="meeting-status__error" data-testid="recording-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
