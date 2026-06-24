/**
 * Pure presentation helpers for the PRD-5 post-processing UI (summary +
 * diarized transcript + speaker rename + processing progress).
 *
 * No React, no window.loqui, no I/O — exhaustively unit-testable. The
 * components import from the ./index barrel.
 */
import {
  SPEAKER_YOU_LABEL,
  type DiarizedSegment,
  type DiarizedTranscript,
  type JobEvent,
  type JobKind,
  type JobState,
} from "@loqui/shared";

/** The post-processing job kinds the UI surfaces (transcription is PRD-2). */
export const POSTPROCESS_JOB_KINDS: readonly JobKind[] = ["diarization", "summary"];

/** Human-facing label for a post-processing job kind. */
export const JOB_KIND_LABEL: Record<JobKind, string> = {
  transcription: "Transcription",
  diarization: "Diarization",
  summary: "Summary",
};

/** Human-facing label for a job state. */
export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  error: "Failed",
  canceled: "Canceled",
};

/** A job is finished (no more progress expected) when done/error/canceled. */
export function isJobTerminal(state: JobState): boolean {
  return state === "done" || state === "error" || state === "canceled";
}

/** Clamp + round a 0..1 fractional progress to an integer percentage. */
export function progressPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.round(clamped * 100);
}

/**
 * Reduce a stream of {@link JobEvent}s into the latest state per post-processing
 * job kind. Later events for the same kind win; only the kinds this UI cares
 * about ({@link POSTPROCESS_JOB_KINDS}) are retained. A terminal "done" never
 * regresses to "running" (out-of-order events are tolerated by keeping the most
 * "advanced" state when timestamps are unavailable — here we simply take the
 * last event, which matches the sidecar's monotonic emission order).
 */
export type JobProgressMap = Partial<Record<JobKind, JobEvent>>;

export function reduceJob(map: JobProgressMap, event: JobEvent): JobProgressMap {
  if (!POSTPROCESS_JOB_KINDS.includes(event.kind)) return map;
  return { ...map, [event.kind]: event };
}

/**
 * Whether post-processing is still in flight given the latest per-kind job
 * map. True when any tracked job is queued/running (or no job has reported yet
 * while the meeting is in the "processing" phase — the caller decides that).
 */
export function isProcessing(map: JobProgressMap): boolean {
  return POSTPROCESS_JOB_KINDS.some((kind) => {
    const ev = map[kind];
    return ev != null && !isJobTerminal(ev.state);
  });
}

/** Whether every tracked job has reported and is terminal. */
export function allJobsTerminal(map: JobProgressMap): boolean {
  const seen = POSTPROCESS_JOB_KINDS.filter((kind) => map[kind] != null);
  return seen.length > 0 && seen.every((kind) => isJobTerminal(map[kind]!.state));
}

/** Is this segment the local user's ("You") stream? */
export function isYou(segment: Pick<DiarizedSegment, "speaker">): boolean {
  return segment.speaker === SPEAKER_YOU_LABEL;
}

/**
 * The display name to show for a diarized segment: the rename when present,
 * else the stable speaker label.
 */
export function speakerDisplay(segment: Pick<DiarizedSegment, "speaker" | "displayName">): string {
  const name = segment.displayName?.trim();
  return name && name.length > 0 ? name : segment.speaker;
}

/**
 * The ordered, distinct list of speaker labels in a diarized transcript, with
 * the resolved display name for each. "You" (the mic stream) is included so the
 * rename UI can offer it too. Order: the transcript's own `speakers` list first
 * (system clusters, first-appearance order), with "You" prepended if any mic
 * segment exists. Each entry maps the STABLE label -> the current displayName.
 */
export interface SpeakerEntry {
  /** Stable label, e.g. "You" or "Speaker 1". */
  label: string;
  /** Current display name (the rename), or null if not renamed. */
  displayName: string | null;
}

export function speakerEntries(d: DiarizedTranscript): SpeakerEntry[] {
  // Resolve the latest displayName per stable label by scanning segments.
  const renameByLabel = new Map<string, string | null>();
  for (const seg of d.segments) {
    const name = seg.displayName?.trim();
    renameByLabel.set(seg.speaker, name && name.length > 0 ? name : null);
  }

  const hasYou = d.segments.some((s) => s.speaker === SPEAKER_YOU_LABEL);
  const ordered: string[] = [];
  if (hasYou) ordered.push(SPEAKER_YOU_LABEL);
  for (const label of d.speakers) {
    if (label !== SPEAKER_YOU_LABEL && !ordered.includes(label)) ordered.push(label);
  }
  // Defensive: include any label found in segments but missing from `speakers`.
  for (const seg of d.segments) {
    if (!ordered.includes(seg.speaker)) ordered.push(seg.speaker);
  }

  return ordered.map((label) => ({
    label,
    displayName: renameByLabel.get(label) ?? null,
  }));
}

/** Format a seconds-from-start timestamp as `m:ss` (or `h:mm:ss`). */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Whether a summary has any renderable content at all. */
export function summaryHasContent(s: {
  tldr: string;
  decisions: string[];
  actionItems: { text: string }[];
  topics: string[];
}): boolean {
  return (
    s.tldr.trim().length > 0 ||
    s.decisions.some((d) => d.trim().length > 0) ||
    s.actionItems.some((a) => a.text.trim().length > 0) ||
    s.topics.some((t) => t.trim().length > 0)
  );
}
