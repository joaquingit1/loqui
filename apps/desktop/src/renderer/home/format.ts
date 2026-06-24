/**
 * Pure presentation helpers for the Home/Today view + Calendar settings (PRD-15).
 *
 * No window/IPC access — just formatting + small derivations over the normalized
 * {@link CalendarEvent}/{@link CalendarConnection} shapes so the components stay
 * thin and the logic is unit-testable in isolation. READ-ONLY: nothing here
 * mutates an event or writes anything.
 */
import type {
  CalendarAttendee,
  CalendarConnection,
  CalendarEvent,
  CalendarPlatform,
  CalendarProviderId,
  StartMeetingParams,
} from "@loqui/shared";

/** Human label for a calendar conferencing platform (null → friendly fallback). */
export const CALENDAR_PLATFORM_LABEL: Record<NonNullable<CalendarPlatform>, string> = {
  "google-meet": "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  other: "Online meeting",
};

export function calendarPlatformLabel(platform: CalendarPlatform): string {
  return platform ? CALENDAR_PLATFORM_LABEL[platform] : "Meeting";
}

/**
 * A short emoji glyph per platform, used as the row's at-a-glance icon. Kept as
 * text (no remote image) so it renders under the strict CSP and in jsdom.
 */
export const CALENDAR_PLATFORM_ICON: Record<NonNullable<CalendarPlatform>, string> = {
  "google-meet": "📹",
  zoom: "🎥",
  teams: "👥",
  other: "🔗",
};

export function calendarPlatformIcon(platform: CalendarPlatform): string {
  return platform ? CALENDAR_PLATFORM_ICON[platform] : "📅";
}

/** Human label for a connectable provider. */
export const CALENDAR_PROVIDER_LABEL: Record<CalendarProviderId, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft 365 / Outlook",
  zoom: "Zoom",
};

export function calendarProviderLabel(provider: CalendarProviderId): string {
  return CALENDAR_PROVIDER_LABEL[provider];
}

/** Short, locale-formatted clock time of an ISO timestamp (e.g. "2:05 PM"). */
export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A relative "in N min / Now / 2h ago" label for an event start vs. a reference now. */
export function formatRelativeStart(startsAt: string, now: Date = new Date()): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return "";
  const diffMs = start.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  // A tight window around the start reads "Now" (just started / about to start).
  if (Math.abs(diffMin) <= 1) return "Now";
  if (diffMin < 0) {
    const past = Math.abs(diffMin);
    return past >= 60 ? `${Math.round(past / 60)}h ago` : `${past} min ago`;
  }
  if (diffMin < 60) return `in ${diffMin} min`;
  const hours = Math.round(diffMin / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** Short weekday + day label for an upcoming (not-today) event (e.g. "Tue, Jun 25"). */
export function formatEventDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** True when the event's start falls on the same local calendar day as `now`. */
export function isToday(startsAt: string, now: Date = new Date()): boolean {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** A compact attendee summary (e.g. "Alex, Sam +2") for a row's meta line. */
export function summarizeAttendees(attendees: CalendarAttendee[]): string {
  const names = attendees
    .map((a) => (a.name?.trim() ? a.name.trim() : (a.email ?? "")))
    .filter((n) => n.length > 0);
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** Last-sync label for a connection row (e.g. "Synced 2:05 PM" / "Never synced"). */
export function formatLastSync(lastSyncAt: CalendarConnection["lastSyncAt"]): string {
  if (!lastSyncAt) return "Never synced";
  const t = formatEventTime(lastSyncAt);
  return t ? `Synced ${t}` : "Synced";
}

/**
 * Map a calendar event's platform to the Meeting platform enum for prefilling a
 * "join & record" start. The two enums share values; `null` stays `null` so the
 * lifecycle defaults it. ("other" is a valid Meeting platform too.)
 */
export function eventStartParams(event: CalendarEvent): StartMeetingParams {
  return {
    title: event.title || undefined,
    platform: event.platform ?? undefined,
  };
}
