import { describe, expect, it } from "vitest";
import { calendarEventSchema, eventStartParams } from "./calendar.js";

function event(over: Record<string, unknown>) {
  return calendarEventSchema.parse({
    startsAt: "2026-06-24T10:00:00.000Z",
    endsAt: "2026-06-24T10:30:00.000Z",
    source: "google",
    ...over,
  });
}

describe("eventStartParams (shared single source for Home + meeting-notification)", () => {
  it("maps title + platform and carries attendees", () => {
    const params = eventStartParams(
      event({
        title: "Weekly Sync",
        platform: "google-meet",
        attendees: [
          { name: "Alex", email: "alex@x.com" },
          { name: "Sam", email: null },
        ],
      }),
    );
    expect(params.title).toBe("Weekly Sync");
    expect(params.platform).toBe("google-meet");
    expect(params.calendarAttendees).toEqual([
      { name: "Alex", email: "alex@x.com" },
      { name: "Sam", email: null },
    ]);
  });

  it("omits empty title/platform/attendees so the lifecycle defaults them", () => {
    const params = eventStartParams(event({ title: "", platform: null, attendees: [] }));
    expect(params.title).toBeUndefined();
    expect(params.platform).toBeUndefined();
    expect(params.calendarAttendees).toBeUndefined();
  });
});
