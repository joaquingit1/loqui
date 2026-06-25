/**
 * Pure, framework-free helpers for the Library view (PRD-3): date grouping,
 * duration formatting, platform/status labels.
 *
 * Kept side-effect-free and DOM-free so they are trivially unit-tested without
 * jsdom or window.loqui. The Library component composes these into its render.
 *
 * Grouping buckets a meeting by its `createdAt` relative to a reference "now":
 * Today / Yesterday / This week (earlier this calendar week) / Earlier. Buckets
 * are emitted newest-first and empty buckets are omitted.
 */
import type { Meeting, MeetingKind, MeetingPlatform, MeetingStatus } from "@loqui/shared";

/** A stable group key, in display (newest-first) order. */
export const GROUP_ORDER = ["today", "yesterday", "thisWeek", "earlier"] as const;
export type GroupKey = (typeof GROUP_ORDER)[number];

/** Human-facing heading for each group. */
export const GROUP_LABEL: Record<GroupKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  earlier: "Earlier",
};

/** One rendered group: its key/label and the meetings in it (newest-first). */
export interface MeetingGroup {
  key: GroupKey;
  label: string;
  meetings: Meeting[];
}

/** Local midnight (start of day) for a Date, as a fresh Date. */
function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Classify a single ISO `createdAt` into a {@link GroupKey} relative to `now`.
 *
 * - `today`: same calendar day as `now`.
 * - `yesterday`: the calendar day before `now`.
 * - `thisWeek`: earlier in the same calendar week (week starts Monday), but
 *   before yesterday.
 * - `earlier`: anything older (or an unparseable date — it sinks to the bottom).
 */
export function groupKeyFor(createdAt: string, now: Date): GroupKey {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return "earlier";

  const today0 = startOfDay(now).getTime();
  const created0 = startOfDay(created).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (created0 === today0) return "today";
  if (created0 === today0 - dayMs) return "yesterday";

  // Start of this calendar week (Monday 00:00). getDay(): 0=Sun..6=Sat.
  const dow = startOfDay(now).getDay();
  const daysSinceMonday = (dow + 6) % 7;
  const weekStart = today0 - daysSinceMonday * dayMs;
  if (created0 >= weekStart && created0 < today0 - dayMs) return "thisWeek";

  return "earlier";
}

/**
 * Sort meetings newest-first (by `createdAt`) and partition into the display
 * groups. Empty groups are dropped; group order follows {@link GROUP_ORDER}.
 * `now` is injectable so tests are deterministic.
 */
export function groupMeetingsByDate(meetings: Meeting[], now: Date = new Date()): MeetingGroup[] {
  const sorted = [...meetings].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  const buckets: Record<GroupKey, Meeting[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const m of sorted) buckets[groupKeyFor(m.createdAt, now)].push(m);

  return GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    label: GROUP_LABEL[key],
    meetings: buckets[key],
  }));
}

/**
 * Format a meeting's duration (startedAt → endedAt) as a compact `h:mm:ss` /
 * `m:ss` clock. Returns `null` when it can't be computed (missing/invalid
 * bounds, or a still-recording meeting with no end) so the caller can show a
 * live/placeholder affordance instead.
 */
export function formatDuration(meeting: Pick<Meeting, "startedAt" | "endedAt">): string | null {
  const { startedAt, endedAt } = meeting;
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;

  const totalSeconds = Math.round((end - start) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Short, locale-formatted clock time of a meeting's `createdAt` (e.g. "2:05 PM"). */
export function formatMeetingTime(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Human label for a platform (null/"other" → friendly fallback). */
export const PLATFORM_LABEL: Record<NonNullable<MeetingPlatform>, string> = {
  "google-meet": "Google Meet",
  zoom: "Zoom",
  teams: "Teams",
  other: "Other",
};

export function platformLabel(platform: MeetingPlatform): string {
  return platform ? PLATFORM_LABEL[platform] : "Unknown";
}

/** Human label for a lifecycle status. */
export const STATUS_LABEL: Record<MeetingStatus, string> = {
  recording: "Recording",
  processing: "Processing",
  done: "Done",
  error: "Error",
};

export function statusLabel(status: MeetingStatus): string {
  return STATUS_LABEL[status];
}

/** A non-empty, trimmed title or a stable fallback so the list never shows blank rows. */
export function displayTitle(meeting: Pick<Meeting, "title">): string {
  const t = meeting.title?.trim();
  return t && t.length > 0 ? t : "Untitled meeting";
}

/**
 * Human label per Meeting kind (PRD-12). The library shows the kind alongside a
 * meeting so imports + voice memos read distinctly from a captured meeting.
 * `"meeting"` returns "" so a normal meeting shows no extra badge.
 */
export const KIND_LABEL: Record<MeetingKind, string> = {
  meeting: "Meeting",
  import: "Imported file",
  "voice-memo": "Voice memo",
};

/** A short icon glyph per kind, for the row badge (degrades to text label). */
export const KIND_ICON: Record<MeetingKind, string> = {
  meeting: "",
  import: "📄",
  "voice-memo": "🎙️",
};

/** Library label for a meeting's kind (defaults to "meeting" for old records). */
export function kindLabel(kind: MeetingKind | undefined): string {
  return KIND_LABEL[kind ?? "meeting"];
}

/** Library icon glyph for a meeting's kind (empty for a normal meeting). */
export function kindIcon(kind: MeetingKind | undefined): string {
  return KIND_ICON[kind ?? "meeting"];
}
