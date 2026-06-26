/**
 * PRD-3 shared library + lifecycle query contracts.
 *
 * These are the cross-process payload shapes for the Library UI (list / search
 * / read transcript / rename) and the meeting lifecycle (start / stop). They
 * are defined in @loqui/shared so the renderer, preload, main IPC handlers, and
 * (later) the MCP server all type against ONE source. Producers/consumers live
 * in the Build phase; this module defines TYPES + zod schemas only.
 */
import { z } from "zod";
import {
  meetingKindSchema,
  meetingPlatformSchema,
  meetingSchema,
  type Meeting,
} from "./meeting.js";
import { TRANSCRIPT_VARIANTS } from "./constants.js";

/**
 * Options for a library list/query (store `listMeetings`). All fields optional;
 * results are newest-first. `from`/`to` are inclusive ISO-8601 bounds on a
 * meeting's `createdAt`; `query` is a full-text match over indexed title +
 * transcript text; `limit` caps the row count.
 */
export const listMeetingsQuerySchema = z
  .object({
    /** Inclusive lower bound on `createdAt` (ISO 8601). */
    from: z.string().datetime({ offset: true }).optional(),
    /** Inclusive upper bound on `createdAt` (ISO 8601). */
    to: z.string().datetime({ offset: true }).optional(),
    /** Full-text query over title + transcript (FTS5). */
    query: z.string().optional(),
    /** Max rows to return. */
    limit: z.number().int().positive().optional(),
  })
  .default({});
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuerySchema>;

/**
 * One full-text search hit: the matched meeting plus a highlighted snippet of
 * the matched text (FTS5 `snippet()` output). Returned by store `searchMeetings`
 * and the `searchMeetings` IPC channel.
 */
export const meetingSearchHitSchema = z.object({
  meeting: meetingSchema,
  /** Highlighted excerpt around the match (may contain `[...]` ellipses). */
  snippet: z.string(),
});
export type MeetingSearchHit = z.infer<typeof meetingSearchHitSchema>;

/** Which transcript file a reader wants (`live` Markdown or `structured` JSONL). */
export const transcriptVariantSchema = z.enum(TRANSCRIPT_VARIANTS).default("live");

/** Params for the `getTranscript` reader IPC channel. */
export const getTranscriptParamsSchema = z.object({
  id: z.string(),
  variant: transcriptVariantSchema,
});
export type GetTranscriptParams = z.infer<typeof getTranscriptParamsSchema>;

/** Params for the `renameMeeting` library IPC channel. */
export const renameMeetingParamsSchema = z.object({
  id: z.string(),
  title: z.string(),
});
export type RenameMeetingParams = z.infer<typeof renameMeetingParamsSchema>;

/** Params for the `deleteMeeting` library IPC channel. Permanently removes the
 * meeting's files + search-index rows (destructive). */
export const deleteMeetingParamsSchema = z.object({
  id: z.string(),
});
export type DeleteMeetingParams = z.infer<typeof deleteMeetingParamsSchema>;

/**
 * Params to START a meeting (lifecycle). All optional — the controller mints
 * the id and defaults the rest, mirroring `createMeeting`. Returns the created
 * `Meeting` (status `"recording"`, `startedAt` set).
 */
export const startMeetingParamsSchema = z
  .object({
    title: z.string().optional(),
    platform: meetingPlatformSchema.optional(),
    /**
     * What KIND of recording to start (PRD-12). Defaults to `"meeting"`.
     * `"voice-memo"` is a mic-only capture (the renderer suppresses the system
     * stream); it still flows through the SAME lifecycle + transcription path.
     */
    kind: meetingKindSchema.optional(),
  })
  .default({});
export type StartMeetingParams = z.infer<typeof startMeetingParamsSchema>;

/** Params to STOP a meeting (lifecycle). */
export const stopMeetingParamsSchema = z.object({ id: z.string() });
export type StopMeetingParams = z.infer<typeof stopMeetingParamsSchema>;

/**
 * Push payload for a meeting lifecycle/status change (main -> renderer), so the
 * Library/live view can react without re-listing. Carries the full updated
 * Meeting.
 */
export const meetingStatusEventSchema = z.object({ meeting: meetingSchema });
export type MeetingStatusEvent = z.infer<typeof meetingStatusEventSchema>;

/** Re-export for convenience so consumers can `import { Meeting } from ...`. */
export type { Meeting };
