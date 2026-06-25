/**
 * Pure home-view formatting helpers (jsdom — under src/renderer/**). Hermetic,
 * deterministic via an injected reference "now". Covers the platform/provider
 * labels, the relative-start phrasing, the today predicate, the attendee
 * summary, the last-sync label, and the event→start-params mapping used by
 * "join & record".
 */
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@loqui/shared";
import {
  calendarPlatformIcon,
  calendarPlatformLabel,
  calendarProviderLabel,
  eventStartParams,
  formatLastSync,
  formatRelativeStart,
  greeting,
  isToday,
  meetingsAhead,
  summarizeAttendees,
} from "./format.js";

const NOW = new Date("2026-06-24T09:00:00");

describe("home/format", () => {
  it("labels + icons platforms (null → fallback)", () => {
    expect(calendarPlatformLabel("google-meet")).toBe("Google Meet");
    expect(calendarPlatformLabel("teams")).toBe("Microsoft Teams");
    expect(calendarPlatformLabel(null)).toBe("Meeting");
    expect(calendarPlatformIcon("zoom")).toBeTruthy();
    expect(calendarPlatformIcon(null)).toBeTruthy();
  });

  it("labels providers", () => {
    expect(calendarProviderLabel("google")).toBe("Google Calendar");
    expect(calendarProviderLabel("microsoft")).toMatch(/Microsoft/);
    expect(calendarProviderLabel("zoom")).toBe("Zoom");
  });

  it("phrases relative start times", () => {
    const at = (h: number, m = 0): string => {
      const d = new Date(NOW);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    expect(formatRelativeStart(at(9, 0), NOW)).toBe("Now");
    expect(formatRelativeStart(at(9, 20), NOW)).toBe("in 20 min");
    expect(formatRelativeStart(at(11, 0), NOW)).toBe("in 2h");
    expect(formatRelativeStart(at(8, 30), NOW)).toBe("30 min ago");
  });

  it("detects same-local-day events", () => {
    const todayPm = new Date(NOW);
    todayPm.setHours(15, 0, 0, 0);
    const tomorrow = new Date(NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(isToday(todayPm.toISOString(), NOW)).toBe(true);
    expect(isToday(tomorrow.toISOString(), NOW)).toBe(false);
  });

  it("summarizes attendees (name fallback to email, +N overflow)", () => {
    expect(summarizeAttendees([])).toBe("");
    expect(summarizeAttendees([{ name: "Alex", email: null }])).toBe("Alex");
    expect(
      summarizeAttendees([
        { name: "", email: "x@y.com" },
        { name: "Sam", email: null },
      ]),
    ).toBe("x@y.com, Sam");
    expect(
      summarizeAttendees([
        { name: "A", email: null },
        { name: "B", email: null },
        { name: "C", email: null },
        { name: "D", email: null },
      ]),
    ).toBe("A, B +2");
  });

  it("labels last-sync (null → Never synced)", () => {
    expect(formatLastSync(null)).toBe("Never synced");
    expect(formatLastSync("2026-06-24T08:00:00.000Z")).toMatch(/^Synced /);
  });

  it("greets by local time of day", () => {
    const at = (h: number): Date => {
      const d = new Date(NOW);
      d.setHours(h, 0, 0, 0);
      return d;
    };
    expect(greeting(at(8))).toBe("Good morning");
    expect(greeting(at(13))).toBe("Good afternoon");
    expect(greeting(at(20))).toBe("Good evening");
  });

  it("summarizes meetings ahead (clear / one / many; only future today events)", () => {
    const at = (h: number, m = 0): string => {
      const d = new Date(NOW);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    const ev = (id: string, h: number, title: string): CalendarEvent => ({
      id,
      title,
      startsAt: at(h),
      endsAt: at(h + 1),
      platform: "zoom",
      joinUrl: null,
      attendees: [],
      source: "google",
      calendarAccount: "me",
      meetingId: null,
    });

    expect(meetingsAhead([], NOW)).toMatch(/Nothing left/i);
    // A past event (08:00) is excluded; only the 10:00 remains → "One meeting".
    expect(meetingsAhead([ev("a", 8, "Done"), ev("b", 10, "Standup")], NOW)).toMatch(
      /One meeting ahead — Standup in 1h\./,
    );
    expect(
      meetingsAhead([ev("b", 10, "Standup"), ev("c", 14, "Review")], NOW),
    ).toMatch(/2 meetings ahead — next: Standup in 1h\./);
  });

  it("maps an event to start params (title/platform; null platform omitted)", () => {
    const base = {
      id: "e",
      startsAt: NOW.toISOString(),
      endsAt: NOW.toISOString(),
      attendees: [],
      source: "google" as const,
      calendarAccount: "me",
      meetingId: null,
      joinUrl: null,
    };
    const withPlatform: CalendarEvent = { ...base, title: "Sync", platform: "zoom" };
    expect(eventStartParams(withPlatform)).toEqual({ title: "Sync", platform: "zoom" });

    const noPlatform: CalendarEvent = { ...base, title: "Call", platform: null };
    expect(eventStartParams(noPlatform)).toEqual({ title: "Call" });

    const noTitle: CalendarEvent = { ...base, title: "", platform: null };
    expect(eventStartParams(noTitle)).toEqual({});
  });
});
