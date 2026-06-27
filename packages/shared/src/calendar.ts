/**
 * PRD-15 — shared Calendar contract seams.
 *
 * The single source of truth for the calendar feature's cross-process shapes:
 * the normalized {@link CalendarEvent} (what the calendar service emits and the
 * renderer Home view consumes), the connect/disconnect/list param + status
 * shapes, and the OAuth-start shape. Lives in @loqui/shared (zod + emitted JSON
 * Schema) so the Electron main process, preload, and renderer all type against
 * ONE definition. @loqui/shared stays zod-only — NO node deps here.
 *
 * READ-ONLY POSTURE: this contract describes events READ from a provider. There
 * is NO create/update/delete event shape — calendar is strictly read-only. The
 * feature never writes a transcript file; `meetingId` only LINKS an existing
 * recording to a scheduled event (set by the lifecycle when "join & record"
 * starts a meeting from an event), it does not create transcript content.
 *
 * Additive + defaulted: every field on {@link CalendarEvent} is defaulted so a
 * partial provider payload (or an older cached event) parses forward without
 * error, exactly like the Meeting model.
 */
import { z } from "zod";
import type { StartMeetingParams } from "./library.js";

/**
 * Which connected account a calendar event came from. The three cloud providers
 * PRD-15 ships; the interface stays open so a `local` (EventKit/Windows) source
 * can be added later without breaking this enum's consumers.
 */
export const CALENDAR_SOURCES = ["google", "microsoft", "zoom"] as const;
export const calendarSourceSchema = z.enum(CALENDAR_SOURCES);
export type CalendarSource = z.infer<typeof calendarSourceSchema>;

/**
 * The conferencing platform a calendar event's join link targets. `null` when
 * the event has no recognized online-meeting link. Distinct from (but aligned
 * with) the Meeting platform enum: a calendar event may resolve to `null`/`other`
 * where a Meeting requires one of its values — the linker maps across.
 */
export const CALENDAR_PLATFORMS = ["google-meet", "zoom", "teams", "other"] as const;
export const calendarPlatformSchema = z.enum(CALENDAR_PLATFORMS).nullable();
export type CalendarPlatform = z.infer<typeof calendarPlatformSchema>;

/** A calendar event attendee. `email` may be absent (display-name-only invitee). */
export const calendarAttendeeSchema = z.object({
  name: z.string().default(""),
  email: z.string().nullable().default(null),
});
export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>;

/**
 * A normalized scheduled meeting, merged + de-duplicated across all connected
 * accounts by the calendar service. `startsAt`/`endsAt` are ISO-8601 with
 * offset. `platform`/`joinUrl` are extracted from provider conference data
 * (Meet hangoutLink, Teams onlineMeeting.joinUrl, Zoom join_url). `meetingId`
 * is null until a recording for this event exists, then carries the linked
 * Meeting.id ("join & record" sets it).
 */
export const calendarEventSchema = z.object({
  id: z.string().default(""),
  title: z.string().default(""),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  /**
   * True for date-only "all-day" events (Google `start.date` / Graph `isAllDay`).
   * Such events have no real start time, so the meeting-notification scheduler
   * skips them (they'd otherwise "start" at local midnight). Defaults false so
   * older cached events + timed events parse forward as timed.
   */
  allDay: z.boolean().default(false),
  platform: calendarPlatformSchema.default(null),
  joinUrl: z.string().nullable().default(null),
  attendees: z.array(calendarAttendeeSchema).default([]),
  source: calendarSourceSchema,
  /** Which connected account this event was read from (e.g. an email address). */
  calendarAccount: z.string().default(""),
  /** Linked Meeting.id once a recording for this event exists; else null. */
  meetingId: z.string().nullable().default(null),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/**
 * Params for `listUpcoming`: how far ahead to look (`withinHours`, default 48)
 * and a result cap (`limit`, default 20). Both optional + defaulted so a bare
 * call returns a sensible upcoming window.
 */
export const listUpcomingParamsSchema = z.object({
  withinHours: z.number().positive().default(48),
  limit: z.number().int().positive().default(20),
});
export type ListUpcomingParams = z.input<typeof listUpcomingParamsSchema>;

/** The provider to connect/disconnect — same enum as {@link CalendarSource}. */
export const calendarProviderSchema = calendarSourceSchema;
export type CalendarProviderId = z.infer<typeof calendarProviderSchema>;

/** Params for `connect(provider)`. */
export const calendarConnectParamsSchema = z.object({
  provider: calendarProviderSchema,
});
export type CalendarConnectParams = z.infer<typeof calendarConnectParamsSchema>;

/**
 * Result of `connect`: whether a connection now exists and (when connected) the
 * account label that was linked. `account` absent on a cancelled/failed connect.
 */
export const calendarConnectResultSchema = z.object({
  connected: z.boolean().default(false),
  account: z.string().optional(),
  /**
   * When `connected` is false, a human-readable reason the connect did not
   * succeed (e.g. "Google calendar isn't configured — set LOQUI_GOOGLE_CLIENT_ID")
   * so the UI can explain WHY instead of a generic "could not connect".
   */
  reason: z.string().optional(),
});
export type CalendarConnectResult = z.infer<typeof calendarConnectResultSchema>;

/** Params for `disconnect(provider, account?)`; omitting `account` clears all accounts for the provider. */
export const calendarDisconnectParamsSchema = z.object({
  provider: calendarProviderSchema,
  account: z.string().optional(),
});
export type CalendarDisconnectParams = z.infer<typeof calendarDisconnectParamsSchema>;

/**
 * One connected account, as listed by `getConnections`. `lastSyncAt` is the
 * ISO-8601 timestamp of the most recent successful sync, or null if never synced.
 */
export const calendarConnectionSchema = z.object({
  provider: calendarProviderSchema,
  account: z.string().default(""),
  lastSyncAt: z.string().datetime({ offset: true }).nullable().default(null),
});
export type CalendarConnection = z.infer<typeof calendarConnectionSchema>;

/**
 * Map a calendar event → {@link StartMeetingParams} for a "join & record" start.
 * The SINGLE source so Home (renderer) and the meeting-notification "Join &
 * Record" handler (main) prefill a recording identically. The calendar + Meeting
 * platform enums share values; `null` becomes `undefined` so the lifecycle
 * defaults it. Carries the invited participants so the AI summary can use real
 * names instead of "Speaker N". Pure — no IO.
 */
export function eventStartParams(event: CalendarEvent): StartMeetingParams {
  return {
    title: event.title || undefined,
    platform: event.platform ?? undefined,
    calendarAttendees:
      event.attendees.length > 0
        ? event.attendees.map((a) => ({ name: a.name, email: a.email }))
        : undefined,
  };
}
