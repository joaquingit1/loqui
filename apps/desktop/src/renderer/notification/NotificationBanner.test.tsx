import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { NotificationBanner } from "./NotificationBanner.js";
import type { CalendarEvent } from "@loqui/shared";

const NOW = new Date("2026-06-24T09:59:00.000Z"); // 1 min before the event

const EVENT: CalendarEvent = {
  id: "e1",
  title: "Weekly Sync",
  startsAt: "2026-06-24T10:00:00.000Z",
  endsAt: "2026-06-24T10:30:00.000Z",
  allDay: false,
  platform: "google-meet",
  joinUrl: "https://meet.example/abc",
  attendees: [],
  source: "google",
  calendarAccount: "me@x.com",
  meetingId: null,
};

function makeApi() {
  let emit: ((e: CalendarEvent) => void) | null = null;
  const api = {
    onMeetingDetected: (cb: (e: CalendarEvent) => void) => {
      emit = cb;
      return () => {
        emit = null;
      };
    },
    join: vi.fn(() => Promise.resolve()),
    dismiss: vi.fn(() => Promise.resolve()),
  };
  return { api, emit: (e: CalendarEvent) => act(() => emit?.(e)) };
}

describe("NotificationBanner", () => {
  it("renders nothing until a meeting is pushed", () => {
    const { api } = makeApi();
    render(<NotificationBanner api={api} now={NOW} />);
    expect(screen.queryByTestId("notif")).toBeNull();
  });

  it("shows the meeting + relative start once pushed", () => {
    const { api, emit } = makeApi();
    render(<NotificationBanner api={api} now={NOW} />);
    emit(EVENT);
    expect(screen.getByTestId("notif").textContent).toContain("Meeting Detected");
    expect(screen.getByTestId("notif-title").textContent).toContain("Weekly Sync");
    // 1 min out → "Now" per formatRelativeStart's tight window.
    expect(screen.getByTestId("notif-title").textContent).toMatch(/Now|in 1 min/);
  });

  it("Join & Record hands the event id to the bridge", () => {
    const { api, emit } = makeApi();
    render(<NotificationBanner api={api} now={NOW} />);
    emit(EVENT);
    const join = screen.getByTestId("notif-join");
    expect(join.textContent).toBe("Join & Record");
    fireEvent.click(join);
    expect(api.join).toHaveBeenCalledWith("e1");
  });

  it("labels the button 'Record' when the event has no join link", () => {
    const { api, emit } = makeApi();
    render(<NotificationBanner api={api} now={NOW} />);
    emit({ ...EVENT, joinUrl: null });
    expect(screen.getByTestId("notif-join").textContent).toBe("Record");
  });

  it("dismiss calls the bridge", () => {
    const { api, emit } = makeApi();
    render(<NotificationBanner api={api} now={NOW} />);
    emit(EVENT);
    fireEvent.click(screen.getByTestId("notif-dismiss"));
    expect(api.dismiss).toHaveBeenCalledTimes(1);
  });
});
