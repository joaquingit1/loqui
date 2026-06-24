/**
 * ProcessingStatus — the post-meeting processing indicator (PRD-5).
 *
 * After a meeting stops, main hands the WAVs to the sidecar which runs
 * diarization + summary as background jobs, emitting {@link JobEvent} progress.
 * This component renders one progress row per post-processing job kind
 * (Diarization, Summary) with its state + a percentage bar, so the user can see
 * the pipeline advance and knows diarization may be skipped (degraded) without
 * the meeting failing.
 *
 * READ-ONLY: it only reflects job progress; it never writes anything. The job
 * map is supplied by the caller (from {@link useJobProgress}) so this component
 * stays presentational + trivially testable.
 */
import type { JSX } from "react";
import type { JobKind } from "@loqui/shared";
import {
  JOB_KIND_LABEL,
  JOB_STATE_LABEL,
  POSTPROCESS_JOB_KINDS,
  isJobTerminal,
  progressPercent,
  type JobProgressMap,
} from "../summary/index.js";
import "../summary/summary.css";

export interface ProcessingStatusProps {
  /** Latest JobEvent per kind (from useJobProgress). */
  jobs: JobProgressMap;
  /**
   * Whether the meeting is in the "processing" phase. When true and no job has
   * reported yet, a "Starting…" placeholder is shown so the indicator is never
   * blank during the handoff.
   */
  active?: boolean;
}

export function ProcessingStatus({ jobs, active = true }: ProcessingStatusProps): JSX.Element | null {
  const reported = POSTPROCESS_JOB_KINDS.filter((kind) => jobs[kind] != null);
  // Nothing to show: not processing and no jobs ever reported.
  if (!active && reported.length === 0) return null;

  return (
    <section
      className="postproc"
      data-testid="processing-status"
      aria-label="Post-processing status"
    >
      <h3 className="postproc__heading">
        Processing meeting
        <span className="postproc__sub">Diarizing speakers and writing the summary…</span>
      </h3>
      <ul className="postproc__jobs">
        {POSTPROCESS_JOB_KINDS.map((kind) => (
          <JobRow key={kind} kind={kind} jobs={jobs} active={active} />
        ))}
      </ul>
    </section>
  );
}

function JobRow({
  kind,
  jobs,
  active,
}: {
  kind: JobKind;
  jobs: JobProgressMap;
  active: boolean;
}): JSX.Element {
  const ev = jobs[kind];
  // Pending = the meeting is processing but this job hasn't reported yet.
  const state = ev?.state ?? (active ? "queued" : "queued");
  const pct = ev ? progressPercent(ev.progress) : 0;
  const terminal = ev ? isJobTerminal(ev.state) : false;
  const errored = ev?.state === "error";
  const label = JOB_KIND_LABEL[kind];

  return (
    <li
      className={`postproc__job postproc__job--${state}`}
      data-testid={`processing-job-${kind}`}
      data-kind={kind}
      data-state={state}
      data-progress={pct}
    >
      <div className="postproc__job-top">
        <span className="postproc__job-name">{label}</span>
        <span
          className={`postproc__job-state postproc__job-state--${state}`}
          data-testid={`processing-job-state-${kind}`}
        >
          {ev ? JOB_STATE_LABEL[ev.state] : active ? "Waiting…" : JOB_STATE_LABEL.queued}
          {ev && !terminal ? ` · ${pct}%` : ""}
        </span>
      </div>
      <div className="postproc__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${label} progress`}>
        <div
          className={`postproc__bar-fill${errored ? " postproc__bar-fill--error" : ""}`}
          style={{ width: `${ev?.state === "done" ? 100 : pct}%` }}
        />
      </div>
      {errored && ev?.error && (
        <p className="postproc__job-error" data-testid={`processing-job-error-${kind}`} role="alert">
          {ev.error}
        </p>
      )}
    </li>
  );
}
