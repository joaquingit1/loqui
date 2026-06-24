/**
 * HomeView — the app's landing "Today" view (PRD-15).
 *
 * Shows the user's scheduled meetings pulled from their connected calendars:
 *   - Today's meetings (soonest-first) with time, a platform icon, an attendee
 *     summary, and a "Join & record" action.
 *   - A small Upcoming peek (the next events beyond today, within the default
 *     window).
 *   - A connect/empty state when no calendar is connected (links into the
 *     Calendar settings panel) or when nothing is scheduled.
 *
 * "Join & record" opens the event's join link (window.open → OS browser in
 * Electron) and starts a meeting pre-filled from the event (title/platform),
 * linking it back via the lifecycle. It then hands the new meeting up to the
 * host so the nav can switch to the active-meeting view.
 *
 * READ-ONLY over the calendar: this view only READS events (listToday /
 * listUpcoming / onUpdated) — it never writes a calendar or a transcript. It
 * talks ONLY to the typed window.loqui.calendar + window.loqui.library bridges
 * (injectable for hermetic tests), never to IPC channels or Node globals.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { CalendarConnection, CalendarEvent, Meeting } from "@loqui/shared";
import type { LoquiCalendarApi, LoquiLibraryApi } from "../../preload/index.js";
import {
  calendarPlatformIcon,
  calendarPlatformLabel,
  eventStartParams,
  formatEventDay,
  formatEventTime,
  formatRelativeStart,
  isToday,
  summarizeAttendees,
} from "../home/format.js";
import "../home/home.css";

export interface HomeViewProps {
  /** Calendar bridge. Injectable for tests; defaults to window.loqui.calendar. */
  calendar?: Pick<
    LoquiCalendarApi,
    "listToday" | "listUpcoming" | "getConnections" | "refresh" | "onUpdated"
  >;
  /** Library bridge for "join & record". Injectable; defaults to window.loqui.library. */
  library?: Pick<LoquiLibraryApi, "startMeeting">;
  /** Open the Calendar settings panel (host-owned nav). */
  onOpenSettings?: () => void;
  /** Called after "join & record" creates a meeting, so the host can switch views. */
  onMeetingStarted?: (meeting: Meeting) => void;
  /** Reference "now"; injectable so tests are deterministic. */
  now?: Date;
  /** Open a join URL; injectable for tests. Defaults to window.open in a new tab. */
  openExternal?: (url: string) => void;
}

function defaultOpenExternal(url: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    // In Electron the window-open handler routes this to the OS browser; in a
    // plain browser it opens a tab. noopener/noreferrer for safety.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function HomeView({
  calendar,
  library,
  onOpenSettings,
  onMeetingStarted,
  now,
  openExternal = defaultOpenExternal,
}: HomeViewProps): JSX.Element {
  const cal =
    calendar ?? (typeof window !== "undefined" ? window.loqui?.calendar : undefined);
  const lib =
    library ?? (typeof window !== "undefined" ? window.loqui?.library : undefined);

  const [today, setToday] = useState<CalendarEvent[]>([]);
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  const refNow = now;

  // Load today's + upcoming events + the current connections.
  const load = useCallback(() => {
    if (!cal?.listToday) {
      setLoaded(true);
      return;
    }
    setError(null);
    Promise.all([
      cal.listToday(),
      cal.listUpcoming?.() ?? Promise.resolve<CalendarEvent[]>([]),
      cal.getConnections?.() ?? Promise.resolve<CalendarConnection[]>([]),
    ])
      .then(([t, u, c]) => {
        setToday(t);
        setUpcoming(u);
        setConnections(c);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoaded(true));
  }, [cal]);

  useEffect(() => {
    load();
  }, [load]);

  // Push: when the event set changes, listToday is the canonical "today" slice,
  // but onUpdated delivers the FULL set — re-derive today from it and re-pull the
  // upcoming peek so both stay in sync without a manual refresh.
  useEffect(() => {
    if (!cal?.onUpdated) return;
    const unsubscribe = cal.onUpdated((events) => {
      setToday(events.filter((e) => isToday(e.startsAt, refNow ?? new Date())));
      cal.listUpcoming?.()
        .then(setUpcoming)
        .catch(() => {
          /* keep the last known upcoming set */
        });
      cal.getConnections?.()
        .then(setConnections)
        .catch(() => {
          /* keep the last known connections */
        });
    });
    return unsubscribe;
  }, [cal, refNow]);

  const onRefresh = useCallback(() => {
    if (!cal?.refresh) {
      load();
      return;
    }
    setError(null);
    cal
      .refresh()
      .then((events) => {
        setToday(events.filter((e) => isToday(e.startsAt, refNow ?? new Date())));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    // Refresh the upcoming peek + connections alongside.
    cal.listUpcoming?.().then(setUpcoming).catch(() => {});
    cal.getConnections?.().then(setConnections).catch(() => {});
  }, [cal, load, refNow]);

  const onJoinAndRecord = useCallback(
    (event: CalendarEvent) => {
      if (event.joinUrl) openExternal(event.joinUrl);
      if (!lib?.startMeeting) return;
      setStartingId(event.id);
      lib
        .startMeeting(eventStartParams(event))
        .then((meeting) => onMeetingStarted?.(meeting))
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setStartingId((id) => (id === event.id ? null : id)));
    },
    [lib, onMeetingStarted, openExternal],
  );

  // Sort soonest-first defensively (the service already sorts, but a partial
  // cached push may not). Today comes pre-filtered to the local day.
  const sortedToday = useMemo(
    () => [...today].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [today],
  );

  // The Upcoming peek is everything beyond today (the service's upcoming window
  // can include today's later items — drop those so the two sections don't
  // duplicate), soonest-first, capped to a short peek.
  const upcomingPeek = useMemo(() => {
    const ref = refNow ?? new Date();
    return [...upcoming]
      .filter((e) => !isToday(e.startsAt, ref))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, 5);
  }, [upcoming, refNow]);

  const connected = connections.length > 0;

  return (
    <section className="panel home" aria-labelledby="home-title" data-testid="home-view">
      <div className="home__bar">
        <div>
          <h2 className="panel__title" id="home-title">
            Today
          </h2>
          <p className="panel__subtitle">Your scheduled meetings, soonest first.</p>
        </div>
        {connected && (
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="home-refresh"
            onClick={onRefresh}
          >
            Refresh
          </button>
        )}
      </div>

      {error && (
        <p className="home__error" data-testid="home-error" role="alert">
          Could not load your calendar: {error}
        </p>
      )}

      {!connected && loaded ? (
        <ConnectPrompt onOpenSettings={onOpenSettings} />
      ) : (
        <>
          {sortedToday.length === 0 ? (
            <p className="home__empty" data-testid="home-today-empty">
              Nothing scheduled for today. Enjoy the quiet — or start a meeting from the
              Library.
            </p>
          ) : (
            <ul className="home__rows" data-testid="home-today">
              {sortedToday.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  now={refNow}
                  starting={startingId === event.id}
                  onJoinAndRecord={onJoinAndRecord}
                />
              ))}
            </ul>
          )}

          {upcomingPeek.length > 0 && (
            <div className="home__upcoming" data-testid="home-upcoming">
              <h3 className="home__subheading">Upcoming</h3>
              <ul className="home__rows home__rows--peek">
                {upcomingPeek.map((event) => (
                  <UpcomingRow key={event.id} event={event} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface ConnectPromptProps {
  onOpenSettings?: () => void;
}

function ConnectPrompt({ onOpenSettings }: ConnectPromptProps): JSX.Element {
  return (
    <div className="home__connect" data-testid="home-connect">
      <p className="home__connect-text">
        Connect a calendar to see today’s meetings here and join &amp; record in one click.
        Loqui reads your events <strong>read-only</strong> — it never changes your calendar.
      </p>
      <button
        type="button"
        className="btn"
        data-testid="home-connect-btn"
        onClick={onOpenSettings}
      >
        Connect a calendar
      </button>
    </div>
  );
}

interface EventRowProps {
  event: CalendarEvent;
  now?: Date;
  starting: boolean;
  onJoinAndRecord: (event: CalendarEvent) => void;
}

function EventRow({ event, now, starting, onJoinAndRecord }: EventRowProps): JSX.Element {
  const attendees = summarizeAttendees(event.attendees);
  return (
    <li className="home__row" data-testid={`home-event-${event.id}`}>
      <span className="home__row-icon" aria-hidden="true">
        {calendarPlatformIcon(event.platform)}
      </span>
      <span className="home__row-main">
        <span className="home__row-title">{event.title || "Untitled meeting"}</span>
        <span className="home__row-meta">
          <span className="home__row-time">{formatEventTime(event.startsAt)}</span>
          <span className="home__row-rel" data-testid={`home-event-rel-${event.id}`}>
            {formatRelativeStart(event.startsAt, now)}
          </span>
          <span className="home__row-platform">{calendarPlatformLabel(event.platform)}</span>
          {attendees && <span className="home__row-attendees">{attendees}</span>}
        </span>
      </span>
      <button
        type="button"
        className="btn btn--join"
        data-testid={`home-join-${event.id}`}
        disabled={starting}
        onClick={() => onJoinAndRecord(event)}
      >
        {starting ? "Starting…" : event.joinUrl ? "Join & record" : "Record"}
      </button>
    </li>
  );
}

interface UpcomingRowProps {
  event: CalendarEvent;
}

function UpcomingRow({ event }: UpcomingRowProps): JSX.Element {
  return (
    <li className="home__row home__row--peek" data-testid={`home-upcoming-${event.id}`}>
      <span className="home__row-icon" aria-hidden="true">
        {calendarPlatformIcon(event.platform)}
      </span>
      <span className="home__row-main">
        <span className="home__row-title">{event.title || "Untitled meeting"}</span>
        <span className="home__row-meta">
          <span className="home__row-day">{formatEventDay(event.startsAt)}</span>
          <span className="home__row-time">{formatEventTime(event.startsAt)}</span>
          <span className="home__row-platform">{calendarPlatformLabel(event.platform)}</span>
        </span>
      </span>
    </li>
  );
}
