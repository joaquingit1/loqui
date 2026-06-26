/**
 * ProcessingStatus — the post-meeting processing indicator (PRD-5).
 *
 * After a meeting stops, the sidecar finishes the accurate transcript + writes
 * the summary in the background. This shows ONE consolidated progress bar (no
 * per-job breakdown — diarization/summary are one "finishing up" step to the
 * user). The bar is a SIMULATED ease-out: it advances quickly through the early
 * portion, then crawls and holds near the end to convey "almost there" while the
 * real work completes — the actual job progress is jumpy/slow, so a smooth
 * simulation reads far better. On completion it snaps to 100%.
 *
 * READ-ONLY: it only reflects that processing is happening. The job map is used
 * solely to surface a hard error (so a failed summary isn't masked by a
 * cheerful bar).
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { type JobProgressMap } from "../summary/index.js";

export interface ProcessingStatusProps {
  /** Latest JobEvent per kind (from useJobProgress). Used only to detect errors. */
  jobs: JobProgressMap;
  /**
   * Whether the meeting is still in the "processing" phase. While true the bar
   * simulates progress; when it flips false the bar snaps to 100%. When false
   * with no jobs ever reported, nothing renders.
   */
  active?: boolean;
}

/** The soft ceiling the simulated bar eases toward, then crawls past slowly. */
const SOFT_CAP = 95;

/**
 * A simulated progress percentage: jumps in early, eases toward {@link SOFT_CAP},
 * then crawls (so it "gets stuck near the end"). Snaps to 100 when not active.
 */
function useSimulatedProgress(active: boolean): number {
  const [pct, setPct] = useState(active ? 8 : 100);
  const ref = useRef(active ? 8 : 100);
  useEffect(() => {
    if (!active) {
      ref.current = 100;
      setPct(100);
      return;
    }
    ref.current = 8;
    setPct(8);
    const id = setInterval(() => {
      const p = ref.current;
      // Below the cap: big steps early, easing as it approaches (fast then slow).
      // At/above the cap: a tiny crawl so it visibly "sticks" near the end.
      const next = p < SOFT_CAP ? p + (SOFT_CAP - p) * 0.08 : Math.min(99, p + 0.06);
      ref.current = next;
      setPct(next);
    }, 120);
    return () => clearInterval(id);
  }, [active]);
  return Math.round(pct);
}

export function ProcessingStatus({ jobs, active = true }: ProcessingStatusProps): JSX.Element | null {
  const reported = Object.values(jobs).filter(Boolean);
  const erroredJob = reported.find((j) => j!.state === "error");
  const pct = useSimulatedProgress(active && !erroredJob);

  // Nothing to show: not processing and no jobs ever reported.
  if (!active && reported.length === 0) return null;

  return (
    <section className="postproc" data-testid="processing-status" aria-label="Post-processing status">
      <h3 className="postproc__heading">
        Finishing up
        <span className="postproc__sub">
          {erroredJob ? "Something went wrong while finishing the notes." : "Writing your notes…"}
        </span>
      </h3>
      <div
        className="postproc__bar postproc__bar--solo"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={erroredJob ? 100 : pct}
        aria-label="Processing progress"
        data-testid="processing-bar"
        data-progress={pct}
      >
        <div
          className={`postproc__bar-fill${erroredJob ? " postproc__bar-fill--error" : ""}`}
          style={{ width: `${erroredJob ? 100 : pct}%` }}
        />
      </div>
      {erroredJob?.error && (
        <p className="postproc__job-error" data-testid="processing-error" role="alert">
          {erroredJob.error}
        </p>
      )}
    </section>
  );
}
