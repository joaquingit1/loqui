import { describe, expect, it, vi } from "vitest";
import { calendarEventSchema, type CalendarEvent } from "@loqui/shared";
import {
  createMeetingNotificationScheduler,
  isAlertableMeeting,
  NOTIFICATION_DEFAULT_LEAD_MS,
} from "./scheduler.js";

/** Controllable clock + manual timer registry so firing is deterministic. */
function harness(startNow = 0) {
  let t = startNow;
  let nextId = 1;
  const timers: { id: number; fireAt: number; cb: () => void; live: boolean }[] = [];
  const setTimer = (cb: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, fireAt: t + ms, cb, live: true });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (h: ReturnType<typeof setTimeout>) => {
    const e = timers.find((x) => x.id === (h as unknown as number));
    if (e) e.live = false;
  };
  const advanceTo = (next: number) => {
    t = next;
    for (const e of timers) {
      if (e.live && e.fireAt <= t) {
        e.live = false;
        e.cb();
      }
    }
  };
  return { now: () => t, setTimer, clearTimer, advanceTo };
}

const START = Date.parse("2026-06-24T10:00:00.000Z");

function ev(over: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return calendarEventSchema.parse({
    startsAt: new Date(START).toISOString(),
    endsAt: new Date(START + 1_800_000).toISOString(),
    source: "google",
    joinUrl: "https://meet.example/x",
    ...over,
  });
}

describe("isAlertableMeeting", () => {
  it("alerts for any timed event — with a link, guests, or bare", () => {
    expect(isAlertableMeeting(ev({ id: "a" }))).toBe(true);
    expect(isAlertableMeeting(ev({ id: "b", joinUrl: null, attendees: [{ name: "X", email: null }] }))).toBe(true);
    expect(isAlertableMeeting(ev({ id: "c", joinUrl: null, attendees: [] }))).toBe(true);
  });
  it("skips all-day blocks and events already linked to a recording", () => {
    expect(isAlertableMeeting(ev({ id: "allday", allDay: true }))).toBe(false);
    expect(isAlertableMeeting(ev({ id: "d", meetingId: "m1" }))).toBe(false);
  });
});

describe("meeting notification scheduler", () => {
  it("arms at startsAt − leadMs and fires exactly once", () => {
    const h = harness(START - 5 * 60_000); // 5 min before start
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({ onFire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.update([ev({ id: "a" })]);
    expect(onFire).not.toHaveBeenCalled();

    h.advanceTo(START - NOTIFICATION_DEFAULT_LEAD_MS); // T-60s
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.lastCall?.[0]?.id).toBe("a");

    h.advanceTo(START); // no second fire
    s.update([ev({ id: "a" })]); // re-pushing the same set doesn't re-fire
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when first observed already inside the lead window", () => {
    const h = harness(START - 30_000); // 30s before start (past the T-60s point)
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({ onFire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.update([ev({ id: "a" })]);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a meeting already well past its start (no stale alerts)", () => {
    const h = harness(START + 10 * 60_000); // 10 min after start
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({ onFire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.update([ev({ id: "a" })]);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("fires a bare timed block, but skips all-day + already-linked events", () => {
    const h = harness(START - 5 * 60_000);
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({ onFire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.update([
      ev({ id: "bare", joinUrl: null, attendees: [] }), // timed, no link/guests → fires
      ev({ id: "allday", allDay: true }),
      ev({ id: "linked", meetingId: "m1" }),
    ]);
    h.advanceTo(START - NOTIFICATION_DEFAULT_LEAD_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.lastCall?.[0]?.id).toBe("bare");
  });

  it("cancels a pending fire when the event leaves the set before its lead point", () => {
    const h = harness(START - 5 * 60_000);
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({ onFire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.update([ev({ id: "a" })]);
    s.update([]); // event removed (cancelled / deleted)
    h.advanceTo(START);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("suppresses the alert when a recording is already active", () => {
    const h = harness(START - 5 * 60_000);
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({
      onFire,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
      isActive: () => true,
    });
    s.update([ev({ id: "a" })]);
    h.advanceTo(START - NOTIFICATION_DEFAULT_LEAD_MS);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("dispose clears armed timers", () => {
    const h = harness(START - 5 * 60_000);
    const onFire = vi.fn();
    const s = createMeetingNotificationScheduler({ onFire, now: h.now, setTimer: h.setTimer, clearTimer: h.clearTimer });
    s.update([ev({ id: "a" })]);
    s.dispose();
    h.advanceTo(START);
    expect(onFire).not.toHaveBeenCalled();
  });
});
