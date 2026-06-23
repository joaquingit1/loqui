/**
 * Library view (PRD-3): a dated, searchable list of past meetings.
 *
 * - Lists meetings newest-first, partitioned into Today / Yesterday / This week
 *   / Earlier groups (see ../library/grouping), each row showing title,
 *   time, duration, platform, status.
 * - A full-text search box queries `searchMeetings` (FTS over title +
 *   transcript) and renders hits with highlighted snippets; clearing it returns
 *   to the plain grouped list.
 * - A date-range filter (from/to) re-runs `listMeetings` with the bounds.
 * - Selecting a row opens the {@link MeetingView} for that meeting.
 *
 * Talks ONLY to the typed `window.loqui.library` bridge — never to IPC channels
 * or Node globals. All bridge access is injectable for hermetic tests.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Meeting, MeetingSearchHit } from "@loqui/shared";
import type { LoquiLibraryApi } from "../../preload/index.js";
import {
  displayTitle,
  formatDuration,
  formatMeetingTime,
  groupMeetingsByDate,
  platformLabel,
  statusLabel,
} from "../library/grouping.js";
import { MeetingView } from "./MeetingView.js";
import "../library/library.css";

export interface LibraryProps {
  /** Library bridge. Injectable for tests; defaults to window.loqui.library. */
  api?: LoquiLibraryApi;
  /** Reference "now" for date grouping. Injectable so tests are deterministic. */
  now?: Date;
}

/** Convert a date-input `yyyy-mm-dd` to an inclusive ISO bound, or undefined. */
function toIsoBound(value: string, end: boolean): string | undefined {
  if (!value) return undefined;
  // value is a local calendar day; widen to its start (00:00) or end (23:59:59.999).
  const d = new Date(value + (end ? "T23:59:59.999" : "T00:00:00"));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function Library({ api, now }: LibraryProps): JSX.Element {
  const library = (api ?? window.loqui?.library) as LoquiLibraryApi | undefined;

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<MeetingSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Load (or reload) the plain list whenever the date bounds change.
  const reload = useCallback(() => {
    if (!library?.listMeetings) {
      setMeetings([]);
      return;
    }
    setListError(null);
    library
      .listMeetings({ from: toIsoBound(from, false), to: toIsoBound(to, true) })
      .then(setMeetings)
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : String(err));
      });
  }, [library, from, to]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Run a search (debounced-on-submit via effect on the trimmed query).
  useEffect(() => {
    const q = search.trim();
    if (q.length === 0) {
      setHits(null);
      setSearching(false);
      return;
    }
    if (!library?.searchMeetings) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    library
      .searchMeetings(q)
      .then((res) => {
        if (!cancelled) setHits(res);
      })
      .catch(() => {
        if (!cancelled) setHits([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, library]);

  const groups = useMemo(() => groupMeetingsByDate(meetings, now), [meetings, now]);

  const selected = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId],
  );

  // When a rename returns an updated meeting, splice it into our cached list.
  const onRenamed = useCallback((updated: Meeting) => {
    setMeetings((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }, []);

  if (selected) {
    return (
      <MeetingView
        meeting={selected}
        api={library}
        onBack={() => setSelectedId(null)}
        onRenamed={onRenamed}
      />
    );
  }

  const searchActive = search.trim().length > 0;

  return (
    <section className="panel library" data-testid="library" aria-labelledby="library-title">
      <h2 className="panel__title" id="library-title">
        Library
      </h2>
      <p className="panel__subtitle">Your past meetings, newest first.</p>

      <div className="library__controls">
        <input
          type="search"
          className="library__search"
          data-testid="library-search"
          placeholder="Search transcripts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search transcripts"
        />
        <div className="library__dates">
          <label className="library__date">
            <span>From</span>
            <input
              type="date"
              data-testid="library-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="library__date">
            <span>To</span>
            <input
              type="date"
              data-testid="library-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
      </div>

      {listError && (
        <p className="library__error" data-testid="library-error" role="alert">
          Could not load meetings: {listError}
        </p>
      )}

      {searchActive ? (
        <SearchResults hits={hits} searching={searching} onOpen={setSelectedId} />
      ) : (
        <GroupedList groups={groups} onOpen={setSelectedId} />
      )}
    </section>
  );
}

interface GroupedListProps {
  groups: ReturnType<typeof groupMeetingsByDate>;
  onOpen: (id: string) => void;
}

function GroupedList({ groups, onOpen }: GroupedListProps): JSX.Element {
  if (groups.length === 0) {
    return (
      <p className="library__empty" data-testid="library-empty">
        No meetings yet. Start a meeting and it will appear here.
      </p>
    );
  }
  return (
    <div className="library__groups">
      {groups.map((group) => (
        <div key={group.key} className="library__group" data-testid={`library-group-${group.key}`}>
          <h3 className="library__group-heading">{group.label}</h3>
          <ul className="library__rows">
            {group.meetings.map((m) => (
              <MeetingRow key={m.id} meeting={m} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

interface MeetingRowProps {
  meeting: Meeting;
  onOpen: (id: string) => void;
}

function MeetingRow({ meeting, onOpen }: MeetingRowProps): JSX.Element {
  const duration = formatDuration(meeting);
  return (
    <li>
      <button
        type="button"
        className="library__row"
        data-testid={`library-row-${meeting.id}`}
        onClick={() => onOpen(meeting.id)}
      >
        <span className="library__row-title">{displayTitle(meeting)}</span>
        <span className="library__row-meta">
          <span className="library__row-time">{formatMeetingTime(meeting.createdAt)}</span>
          {duration && <span className="library__row-duration">{duration}</span>}
          <span className="library__row-platform">{platformLabel(meeting.platform)}</span>
          <span
            className={`library__row-status library__row-status--${meeting.status}`}
            data-status={meeting.status}
          >
            {statusLabel(meeting.status)}
          </span>
        </span>
      </button>
    </li>
  );
}

interface SearchResultsProps {
  hits: MeetingSearchHit[] | null;
  searching: boolean;
  onOpen: (id: string) => void;
}

function SearchResults({ hits, searching, onOpen }: SearchResultsProps): JSX.Element {
  if (hits === null || searching) {
    return (
      <p className="library__hint" data-testid="library-searching">
        Searching…
      </p>
    );
  }
  if (hits.length === 0) {
    return (
      <p className="library__empty" data-testid="library-search-empty">
        No matches.
      </p>
    );
  }
  return (
    <ul className="library__rows library__search-results" data-testid="library-search-results">
      {hits.map(({ meeting, snippet }) => (
        <li key={meeting.id}>
          <button
            type="button"
            className="library__row library__row--search"
            data-testid={`library-hit-${meeting.id}`}
            onClick={() => onOpen(meeting.id)}
          >
            <span className="library__row-title">{displayTitle(meeting)}</span>
            <span
              className="library__snippet"
              data-testid={`library-snippet-${meeting.id}`}
            >
              {snippet}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
