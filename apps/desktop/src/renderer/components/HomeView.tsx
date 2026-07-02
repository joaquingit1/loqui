/**
 * HomeView — the app's landing "Home" view (PRD-15 data, PRD-16 Phase 2 skin).
 *
 * ref-1 aesthetic: a warm serif greeting ("Good afternoon") over the hero wash
 * with a one-line "meetings ahead" summary, a "Meetings ahead" section showing
 * today's/upcoming scheduled meetings as soft rounded cards (with the join-link
 * / "join & record" actions preserved), and quick-start action cards.
 *
 * Shows the user's scheduled meetings pulled from their connected calendars:
 *   - Today's meetings (soonest-first) with time, a platform icon, an attendee
 *     summary, and a "Record" action.
 *   - A small Upcoming peek (the next events beyond today, within the default
 *     window).
 *   - A connect/empty state when no calendar is connected (links into the
 *     Calendar settings panel) or when nothing is scheduled.
 *
 * "Record" starts a meeting pre-filled from the event (title/platform), linking
 * it back via the lifecycle, and hands the new meeting up to the host so the nav
 * can switch to the active-meeting view. It does NOT open the join link —
 * joining (in the user's default browser) lives only on the "Meeting Detected"
 * popup notification.
 *
 * READ-ONLY over the calendar: this view only READS events (listToday /
 * listUpcoming / onUpdated) — it never writes a calendar or a transcript. It
 * talks ONLY to the typed window.loqui.calendar + window.loqui.library bridges
 * (injectable for hermetic tests), never to IPC channels or Node globals.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { CalendarConnection, CalendarEvent, StartMeetingParams } from "@loqui/shared";
import type { LoquiCalendarApi } from "../../preload/index.js";
import { Icon } from "./Icon.js";
import {
  calendarPlatformIcon,
  calendarPlatformLabel,
  eventStartParams,
  formatEventDay,
  formatEventTime,
  formatRelativeStart,
  greeting,
  isToday,
  meetingsAhead,
  summarizeAttendees,
} from "../home/format.js";
import "../home/home.css";

export interface HomeViewProps {
  /** Calendar bridge. Injectable for tests; defaults to window.loqui.calendar. */
  calendar?: Pick<
    LoquiCalendarApi,
    "listToday" | "listUpcoming" | "getConnections" | "refresh" | "onUpdated"
  >;
  /** Open the Calendar settings panel (host-owned nav). */
  onOpenSettings?: () => void;
  /** Open the full searchable Library (host-owned nav). */
  onOpenLibrary?: () => void;
  /**
   * Request a recording. The host switches to the Meeting view and the meeting
   * controller does the single startMeeting + capture (with the optional prefill
   * from "join & record"). Home NEVER mints a meeting itself, so the recording's
   * meetingId / capture / live transcript can't diverge.
   */
  onStartMeeting?: (params?: StartMeetingParams) => void;
  /** Reference "now"; injectable so tests are deterministic. */
  now?: Date;
}

export function HomeView({
  calendar,
  onOpenSettings,
  onOpenLibrary,
  onStartMeeting,
  now,
}: HomeViewProps): JSX.Element {
  const cal =
    calendar ?? (typeof window !== "undefined" ? window.loqui?.calendar : undefined);

  const [today, setToday] = useState<CalendarEvent[]>([]);
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // "Record": ask the host to start a recording PREFILLED from the event
  // (title/platform). The host's meeting controller does the actual startMeeting
  // + capture (one owner; no divergence). It does NOT open the meeting link —
  // joining (in the user's default browser) lives only on the "Meeting Detected"
  // popup notification.
  const onRecord = useCallback(
    (event: CalendarEvent) => {
      onStartMeeting?.(eventStartParams(event));
    },
    [onStartMeeting],
  );

  // "Start a meeting now" (quick action): hand the start intent up; the host
  // switches to the Meeting view where the controller starts + captures.
  const onStartNow = useCallback(() => {
    onStartMeeting?.();
  }, [onStartMeeting]);

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
  const refDate = refNow ?? new Date();
  const aheadLine = connected ? meetingsAhead(sortedToday, refDate) : null;

  return (
    <section className="home" aria-labelledby="home-title" data-testid="home-view">
      <div className="home__hero">
        <div className="home__hero-bar">
          <h2 className="home__greeting" id="home-title">
            {greeting(refDate)}
          </h2>
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
        {aheadLine && (
          <p className="home__ahead" data-testid="home-ahead">
            {aheadLine}
          </p>
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
        <div className="home__section" data-testid="home-meetings-ahead">
          <div className="home__section-head">
            <h3 className="home__section-title">Meetings ahead</h3>
          </div>
          {sortedToday.length === 0 ? (
            <p className="home__empty" data-testid="home-today-empty">
              Nothing scheduled for today. Enjoy the quiet — or start a meeting below.
            </p>
          ) : (
            <ul className="home__rows" data-testid="home-today">
              {sortedToday.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  now={refNow}
                  onRecord={onRecord}
                />
              ))}
            </ul>
          )}

          {upcomingPeek.length > 0 && (
            <div className="home__upcoming" data-testid="home-upcoming">
              <p className="home__overline">Upcoming</p>
              <ul className="home__rows home__rows--peek">
                {upcomingPeek.map((event) => (
                  <UpcomingRow key={event.id} event={event} onRecord={onRecord} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="home__section" data-testid="home-quick">
        <p className="home__overline">Quick start</p>
        <div className="home__quick">
          <QuickAction
            title="Start a meeting"
            desc="Record + transcribe a live meeting now."
            testid="home-quick-start"
            disabled={!onStartMeeting}
            onClick={onStartNow}
          />
          <QuickAction
            title="Browse library"
            desc="Search and reopen your past meetings."
            testid="home-quick-library"
            disabled={!onOpenLibrary}
            onClick={() => onOpenLibrary?.()}
          />
          <QuickAction
            title="Calendar settings"
            desc="Connect or manage your calendars."
            testid="home-quick-calendar"
            disabled={!onOpenSettings}
            onClick={() => onOpenSettings?.()}
          />
          <QuickAction
            title="Refresh schedule"
            desc="Re-sync today's events from your calendar."
            testid="home-quick-refresh"
            disabled={!connected}
            onClick={onRefresh}
          />
        </div>
      </div>
    </section>
  );
}

interface QuickActionProps {
  title: string;
  desc: string;
  testid: string;
  disabled?: boolean;
  onClick: () => void;
}

function QuickAction({ title, desc, testid, disabled, onClick }: QuickActionProps): JSX.Element {
  return (
    <button
      type="button"
      className="home__quick-action"
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="home__quick-action-title">{title}</span>
      <span className="home__quick-action-desc">{desc}</span>
    </button>
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
  onRecord: (event: CalendarEvent) => void;
}

function EventRow({ event, now, onRecord }: EventRowProps): JSX.Element {
  const attendees = summarizeAttendees(event.attendees);
  return (
    <li className="home__event" data-testid={`home-event-${event.id}`}>
      <span className="home__event-when">
        <time className="home__event-time" dateTime={event.startsAt}>
          {formatEventTime(event.startsAt)}
        </time>
        <span className="home__event-rel" data-testid={`home-event-rel-${event.id}`}>
          {formatRelativeStart(event.startsAt, now)}
        </span>
      </span>
      <span className="home__event-body">
        <span className="home__event-title">{event.title || "Untitled meeting"}</span>
        <span className="home__event-meta">
          <span className="home__event-platform">
            <Icon name={calendarPlatformIcon(event.platform)} size={14} />
            {calendarPlatformLabel(event.platform)}
          </span>
          {attendees && <span className="home__event-people">{attendees}</span>}
        </span>
      </span>
      <button
        type="button"
        className="btn btn--join"
        data-testid={`home-record-${event.id}`}
        onClick={() => onRecord(event)}
      >
        Record
      </button>
    </li>
  );
}

interface UpcomingRowProps {
  event: CalendarEvent;
  onRecord: (event: CalendarEvent) => void;
}

function UpcomingRow({ event, onRecord }: UpcomingRowProps): JSX.Element {
  return (
    <li className="home__event home__event--peek" data-testid={`home-upcoming-${event.id}`}>
      <span className="home__event-when">
        <span className="home__event-day">{formatEventDay(event.startsAt)}</span>
        <time className="home__event-time" dateTime={event.startsAt}>
          {formatEventTime(event.startsAt)}
        </time>
      </span>
      <span className="home__event-body">
        <span className="home__event-title">{event.title || "Untitled meeting"}</span>
        <span className="home__event-meta">
          <span className="home__event-platform">
            <Icon name={calendarPlatformIcon(event.platform)} size={14} />
            {calendarPlatformLabel(event.platform)}
          </span>
        </span>
      </span>
      <button
        type="button"
        className="btn btn--join"
        data-testid={`home-record-${event.id}`}
        onClick={() => onRecord(event)}
      >
        Record
      </button>
    </li>
  );
}
