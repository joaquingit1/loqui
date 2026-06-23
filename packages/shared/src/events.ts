/**
 * Server-initiated event payloads (sidecar → main → renderer). These ride the
 * WS control channel as `notification` envelopes (see ./protocol.ts) whose
 * `event` field names the kind and whose `data` is one of the shapes below.
 *
 * NOTE: Producers and consumers of these events are implemented in LATER PRDs
 * (transcription, diarization, summaries). This module defines the TYPES only.
 */
import { z } from "zod";
import { audioSourceSchema } from "./audio.js";

/** Notification `event` name constants. */
export const EVENT = {
  transcriptSegment: "transcriptSegment",
  jobUpdate: "jobUpdate",
} as const;

/**
 * The exact WS-notification `event` string the transcription engine (PRD-2,
 * sidecar) emits and the main process matches on to forward a
 * {@link TranscriptSegment} to the renderer. Equals {@link EVENT.transcriptSegment};
 * named separately so the four PRD-2 build units (sidecar emitter, main bridge,
 * preload, renderer view) all reference ONE symbol rather than the bare literal.
 */
export const TRANSCRIPT_SEGMENT_EVENT = EVENT.transcriptSegment;

/**
 * A transcript segment for one source. `partial` segments may be superseded by
 * a later `final` segment with the same segId. tStart/tEnd are seconds from
 * the meeting start.
 */
export const transcriptSegmentSchema = z.object({
  meetingId: z.string().uuid(),
  source: audioSourceSchema,
  text: z.string().default(""),
  tStart: z.number().default(0),
  tEnd: z.number().default(0),
  status: z.enum(["partial", "final"]).default("partial"),
  segId: z.string().min(1),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const jobKindSchema = z.enum(["transcription", "diarization", "summary"]);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStateSchema = z.enum([
  "queued",
  "running",
  "done",
  "error",
  "canceled",
]);
export type JobState = z.infer<typeof jobStateSchema>;

/** Progress/state update for a long-running sidecar job. */
export const jobUpdateSchema = z.object({
  jobId: z.string().min(1),
  kind: jobKindSchema,
  state: jobStateSchema.default("queued"),
  /** 0..1 fractional progress. */
  progress: z.number().min(0).max(1).default(0),
  error: z.string().nullable().default(null).optional(),
});
export type JobUpdate = z.infer<typeof jobUpdateSchema>;
