/**
 * HomeView tests (jsdom). HERMETIC: the calendar + library bridges are injected
 * as controllable fakes (no window.loqui, no IPC, no network). Covers: today /
 * upcoming / empty / connect states render from mock data; the soonest-first
 * ordering; the onUpdated push refreshes today; "join & record" opens the join
 * URL and starts a meeting pre-filled from the event; and the connect-state CTA
 * opens settings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CalendarConnection, CalendarEvent, Meeting } from "@loqui/shared";
import { HomeView } from "./HomeView.js";
import type { LoquiCalendarApi, LoquiLibraryApi } from "../../preload/index.js";

afterEach(cleanup);

// Deterministic reference "now": 2026-06-24 09:00 local.
const NOW = new Date("2026-06-24T09:00:00");

function iso(dayOffsetDays: number, h: number, m = 0): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() + dayOffsetDays);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "evt",
    title: "Untitled",
    startsAt: iso(0, 10),
    endsAt: iso(0, 11),
    platform: "google-meet",
    joinUrl: "https://meet.example/abc",
    attendees: [],
    source: "google",
    calendarAccount: "me@example.com",
    meetingId: null,
    ...overrides,
  };
}

const TODAY_LATER = event({
  id: "t2",
  title: "Design review",
  startsAt: iso(0, 14),
  platform: "teams",
  joinUrl: "https://teams.example/xyz",
  attendees: [{ name: "Sam", email: "sam@x.com" }],
});
const TODAY_SOON = event({
  id: "t1",
  title: "Standup",
  startsAt: iso(0, 10),
  platform: "google-meet",
  joinUrl: "https://meet.example/abc",
  attendees: [
    { name: "Alex", email: "alex@x.com" },
    { name: "Sam", email: "sam@x.com" },
    { name: "Jo", email: "jo@x.com" },
  ],
});
const TOMORROW = event({
  id: "u1",
  title: "1:1",
  startsAt: iso(1, 11),
  platform: "zoom",
  joinUrl: "https://zoom.example/1",
});

const CONNECTIONS: CalendarConnection[] = [
  { provider: "google", account: "me@example.com", lastSyncAt: iso(0, 8) },
];

type CalApi = Pick<
  LoquiCalendarApi,
  "listToday" | "listUpcoming" | "getConnections" | "refresh" | "onUpdated"
>;

function makeCalendar(
  opts: {
    today?: CalendarEvent[];
    upcoming?: CalendarEvent[];
    connections?: CalendarConnection[];
    overrides?: Partial<CalApi>;
  } = {},
): { api: CalApi; emitUpdated: (events: CalendarEvent[]) => void } {
  let cb: ((events: CalendarEvent[]) => void) | null = null;
  const api: CalApi = {
    listToday: vi.fn(async () => opts.today ?? []),
    listUpcoming: vi.fn(async () => opts.upcoming ?? []),
    getConnections: vi.fn(async () => opts.connections ?? CONNECTIONS),
    refresh: vi.fn(async () => opts.today ?? []),
    onUpdated: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    ...opts.overrides,
  };
  return { api, emitUpdated: (events) => cb?.(events) };
}

function makeLibrary(
  overrides: Partial<Pick<LoquiLibraryApi, "startMeeting">> = {},
): Pick<LoquiLibraryApi, "startMeeting"> {
  return {
    startMeeting: vi.fn(async (params) => ({ id: "m1", ...params }) as unknown as Meeting),
    ...overrides,
  };
}

describe("HomeView", () => {
  it("renders the serif greeting + a meetings-ahead summary over the hero", async () => {
    const { api } = makeCalendar({ today: [TODAY_LATER, TODAY_SOON] });
    render(<HomeView calendar={api} library={makeLibrary()} now={NOW} />);

    // NOW is 09:00 → "Good morning"; the greeting is the labelled home title.
    expect(screen.getByRole("heading", { name: /good morning/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("home-ahead")).toBeTruthy());
    // Two today events both start after 09:00 → "2 meetings ahead".
    expect(screen.getByTestId("home-ahead").textContent).toMatch(/2 meetings ahead/i);
    expect(screen.getByTestId("home-meetings-ahead")).toBeTruthy();
  });

  it("renders quick-start action cards; Start a meeting mints + hands up a meeting", async () => {
    const onMeetingStarted = vi.fn();
    const library = makeLibrary();
    const { api } = makeCalendar({ today: [] });
    render(
      <HomeView
        calendar={api}
        library={library}
        now={NOW}
        onMeetingStarted={onMeetingStarted}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("home-quick")).toBeTruthy());
    expect(screen.getByTestId("home-quick-start")).toBeTruthy();
    expect(screen.getByTestId("home-quick-library")).toBeTruthy();

    fireEvent.click(screen.getByTestId("home-quick-start"));
    await waitFor(() => expect(library.startMeeting).toHaveBeenCalledTimes(1));
    // No event prefill for a blank "start now".
    expect(library.startMeeting).toHaveBeenCalledWith();
    await waitFor(() => expect(onMeetingStarted).toHaveBeenCalledTimes(1));
  });

  it("the Browse library quick card calls onOpenLibrary", async () => {
    const onOpenLibrary = vi.fn();
    const { api } = makeCalendar({ today: [] });
    render(
      <HomeView calendar={api} library={makeLibrary()} now={NOW} onOpenLibrary={onOpenLibrary} />,
    );
    await waitFor(() => expect(screen.getByTestId("home-quick-library")).toBeTruthy());
    fireEvent.click(screen.getByTestId("home-quick-library"));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("renders today's meetings soonest-first with time, platform, attendees", async () => {
    const { api } = makeCalendar({ today: [TODAY_LATER, TODAY_SOON] });
    render(<HomeView calendar={api} library={makeLibrary()} now={NOW} />);

    await waitFor(() => expect(screen.getByTestId("home-today")).toBeTruthy());
    const ids = screen
      .getAllByTestId(/^home-event-(?!rel)/)
      .map((el) => el.getAttribute("data-testid"));
    // Soonest-first: 10:00 Standup before 14:00 Design review.
    expect(ids).toEqual(["home-event-t1", "home-event-t2"]);

    const standup = screen.getByTestId("home-event-t1");
    expect(standup.textContent).toContain("Standup");
    expect(standup.textContent).toContain("Google Meet");
    // 3 attendees → "Alex, Sam +1".
    expect(standup.textContent).toContain("Alex, Sam +1");
  });

  it("renders an Upcoming peek for events beyond today (de-duped from today)", async () => {
    const { api } = makeCalendar({
      today: [TODAY_SOON],
      upcoming: [TODAY_SOON, TOMORROW], // service may include today's items
    });
    render(<HomeView calendar={api} library={makeLibrary()} now={NOW} />);

    await waitFor(() => expect(screen.getByTestId("home-upcoming")).toBeTruthy());
    const peek = screen.getByTestId("home-upcoming");
    expect(peek.textContent).toContain("1:1");
    // The today item is NOT duplicated into the upcoming peek.
    expect(screen.queryByTestId("home-upcoming-t1")).toBeNull();
    expect(screen.getByTestId("home-upcoming-u1")).toBeTruthy();
  });

  it("shows the today-empty state when connected but nothing is scheduled", async () => {
    const { api } = makeCalendar({ today: [], upcoming: [], connections: CONNECTIONS });
    render(<HomeView calendar={api} library={makeLibrary()} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("home-today-empty")).toBeTruthy());
    expect(screen.queryByTestId("home-connect")).toBeNull();
  });

  it("shows the connect/empty state when no calendar is connected", async () => {
    const onOpenSettings = vi.fn();
    const { api } = makeCalendar({ today: [], upcoming: [], connections: [] });
    render(
      <HomeView calendar={api} library={makeLibrary()} now={NOW} onOpenSettings={onOpenSettings} />,
    );
    await waitFor(() => expect(screen.getByTestId("home-connect")).toBeTruthy());
    expect(screen.getByTestId("home-connect").textContent).toMatch(/read-only/i);

    fireEvent.click(screen.getByTestId("home-connect-btn"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("refreshes today on an onUpdated push", async () => {
    const { api, emitUpdated } = makeCalendar({ today: [TODAY_SOON] });
    render(<HomeView calendar={api} library={makeLibrary()} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("home-event-t1")).toBeTruthy());

    // Push a new full set including a second today event.
    act(() => emitUpdated([TODAY_SOON, TODAY_LATER, TOMORROW]));
    await waitFor(() => expect(screen.getByTestId("home-event-t2")).toBeTruthy());
    expect(screen.getByTestId("home-event-t1")).toBeTruthy();
  });

  it("join & record opens the join URL and starts a meeting pre-filled from the event", async () => {
    const openExternal = vi.fn();
    const onMeetingStarted = vi.fn();
    const library = makeLibrary();
    const { api } = makeCalendar({ today: [TODAY_SOON] });
    render(
      <HomeView
        calendar={api}
        library={library}
        now={NOW}
        openExternal={openExternal}
        onMeetingStarted={onMeetingStarted}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("home-join-t1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("home-join-t1"));

    expect(openExternal).toHaveBeenCalledWith("https://meet.example/abc");
    await waitFor(() => expect(library.startMeeting).toHaveBeenCalledTimes(1));
    expect(library.startMeeting).toHaveBeenCalledWith({
      title: "Standup",
      platform: "google-meet",
    });
    await waitFor(() => expect(onMeetingStarted).toHaveBeenCalledTimes(1));
  });

  it("records without a join URL (no openExternal) when the event has none", async () => {
    const openExternal = vi.fn();
    const library = makeLibrary();
    const noLink = event({ id: "t1", title: "Phone call", joinUrl: null, platform: null });
    const { api } = makeCalendar({ today: [noLink] });
    render(<HomeView calendar={api} library={library} now={NOW} openExternal={openExternal} />);
    await waitFor(() => expect(screen.getByTestId("home-join-t1")).toBeTruthy());
    expect(screen.getByTestId("home-join-t1").textContent).toContain("Record");

    fireEvent.click(screen.getByTestId("home-join-t1"));
    expect(openExternal).not.toHaveBeenCalled();
    await waitFor(() => expect(library.startMeeting).toHaveBeenCalledWith({ title: "Phone call" }));
  });

  it("surfaces a load error without throwing", async () => {
    const { api } = makeCalendar({
      overrides: {
        listToday: vi.fn(async () => {
          throw new Error("calendar offline");
        }),
      },
    });
    render(<HomeView calendar={api} library={makeLibrary()} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("home-error").textContent).toContain("calendar offline"));
  });

  it("renders without a bridge (no window.loqui) without throwing", () => {
    expect(() => render(<HomeView now={NOW} />)).not.toThrow();
  });
});
