/**
 * Pure grouping/formatting helper tests (PRD-3 Library). HERMETIC: no jsdom,
 * no window.loqui, no clock dependence — `now` is injected so buckets are
 * deterministic.
 */
import { describe, expect, it } from "vitest";
import type { Meeting } from "@loqui/shared";
import {
  displayTitle,
  formatDuration,
  groupKeyFor,
  groupMeetingsByDate,
  platformLabel,
  statusLabel,
} from "./grouping.js";

/** Build a Meeting with a given createdAt; other fields defaulted. */
function meeting(overrides: Partial<Meeting> & { id: string; createdAt: string }): Meeting {
  return {
    title: "",
    platform: null,
    startedAt: null,
    endedAt: null,
    status: "done",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    calendarAttendees: [],
    titleEdited: false,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

// A fixed reference "now": Wednesday 2026-06-24 at 15:00 local.
const NOW = new Date("2026-06-24T15:00:00");

describe("groupKeyFor", () => {
  it("classifies the same calendar day as today", () => {
    expect(groupKeyFor("2026-06-24T09:00:00", NOW)).toBe("today");
    expect(groupKeyFor("2026-06-24T23:30:00", NOW)).toBe("today");
  });

  it("classifies the previous calendar day as yesterday", () => {
    expect(groupKeyFor("2026-06-23T22:00:00", NOW)).toBe("yesterday");
  });

  it("classifies earlier-this-week (Mon/Tue) as thisWeek", () => {
    // Week starts Monday 2026-06-22.
    expect(groupKeyFor("2026-06-22T08:00:00", NOW)).toBe("thisWeek");
  });

  it("classifies last week as earlier", () => {
    expect(groupKeyFor("2026-06-21T08:00:00", NOW)).toBe("earlier");
    expect(groupKeyFor("2026-05-01T08:00:00", NOW)).toBe("earlier");
  });

  it("sinks an unparseable date to earlier", () => {
    expect(groupKeyFor("not-a-date", NOW)).toBe("earlier");
  });
});

describe("groupMeetingsByDate", () => {
  it("partitions, drops empty buckets, and orders newest-first within a group", () => {
    const meetings = [
      meeting({ id: "a", createdAt: "2026-06-24T09:00:00" }), // today (older)
      meeting({ id: "b", createdAt: "2026-06-24T14:00:00" }), // today (newer)
      meeting({ id: "c", createdAt: "2026-06-23T10:00:00" }), // yesterday
      meeting({ id: "e", createdAt: "2026-05-01T10:00:00" }), // earlier
    ];
    const groups = groupMeetingsByDate(meetings, NOW);
    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday", "earlier"]);
    // Newest-first inside Today.
    expect(groups[0]!.meetings.map((m) => m.id)).toEqual(["b", "a"]);
    expect(groups[0]!.label).toBe("Today");
  });

  it("returns an empty array for no meetings", () => {
    expect(groupMeetingsByDate([], NOW)).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats m:ss under an hour", () => {
    expect(
      formatDuration({ startedAt: "2026-06-24T15:00:00Z", endedAt: "2026-06-24T15:03:05Z" }),
    ).toBe("3:05");
  });

  it("formats h:mm:ss at/over an hour", () => {
    expect(
      formatDuration({ startedAt: "2026-06-24T15:00:00Z", endedAt: "2026-06-24T16:02:09Z" }),
    ).toBe("1:02:09");
  });

  it("returns null when bounds are missing or invalid", () => {
    expect(formatDuration({ startedAt: null, endedAt: null })).toBeNull();
    expect(formatDuration({ startedAt: "2026-06-24T15:00:00Z", endedAt: null })).toBeNull();
    expect(
      formatDuration({ startedAt: "2026-06-24T16:00:00Z", endedAt: "2026-06-24T15:00:00Z" }),
    ).toBeNull();
  });
});

describe("labels", () => {
  it("labels platforms with a fallback for null", () => {
    expect(platformLabel("google-meet")).toBe("Google Meet");
    expect(platformLabel("zoom")).toBe("Zoom");
    expect(platformLabel(null)).toBe("Unknown");
  });

  it("labels statuses", () => {
    expect(statusLabel("recording")).toBe("Recording");
    expect(statusLabel("done")).toBe("Done");
  });

  it("falls back to Untitled for blank titles", () => {
    expect(displayTitle({ title: "" })).toBe("Untitled meeting");
    expect(displayTitle({ title: "   " })).toBe("Untitled meeting");
    expect(displayTitle({ title: "Standup" })).toBe("Standup");
  });
});
