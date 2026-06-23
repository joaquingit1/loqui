/**
 * The Meeting model — the canonical record persisted to
 * `<dataRoot>/meetings/<id>/meta.json` and indexed in `index.db`.
 *
 * Every field is defaulted so that older meta.json files (written by earlier
 * versions, or partial input from callers) parse forward without error.
 */
import { z } from "zod";

export const meetingPlatformSchema = z
  .enum(["google-meet", "zoom", "teams", "other"])
  .nullable();
export type MeetingPlatform = z.infer<typeof meetingPlatformSchema>;

export const meetingStatusSchema = z
  .enum(["recording", "processing", "done", "error"])
  .default("recording");
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

/** A meeting participant. Names are filled in by the speaker-names PRD. */
export const participantSchema = z.object({
  id: z.string().default(""),
  name: z.string().default(""),
  /** Maps a diarized speaker label (e.g. "spk_0") to this participant. */
  speakerLabel: z.string().nullable().default(null),
});
export type Participant = z.infer<typeof participantSchema>;

export const meetingSchema = z.object({
  id: z.string().uuid(),
  title: z.string().default(""),
  platform: meetingPlatformSchema.default(null),
  startedAt: z.string().datetime({ offset: true }).nullable().default(null),
  endedAt: z.string().datetime({ offset: true }).nullable().default(null),
  status: meetingStatusSchema,
  participants: z.array(participantSchema).default([]),
  /** Map of pipeline-stage -> model identifier used to produce that stage. */
  modelVersions: z.record(z.string(), z.string()).default({}),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Meeting = z.infer<typeof meetingSchema>;

/**
 * Input accepted by `createMeeting`. Everything is optional; the store fills
 * id/createdAt/updatedAt and defaults the rest.
 */
export const createMeetingInputSchema = meetingSchema
  .partial()
  .omit({ id: true, createdAt: true, updatedAt: true });
export type CreateMeetingInput = z.infer<typeof createMeetingInputSchema>;

/**
 * Patch accepted by `updateMeeting` — any subset of mutable fields.
 * id/createdAt are immutable; updatedAt is set by the store.
 */
export const updateMeetingInputSchema = meetingSchema
  .partial()
  .omit({ id: true, createdAt: true, updatedAt: true });
export type UpdateMeetingInput = z.infer<typeof updateMeetingInputSchema>;
