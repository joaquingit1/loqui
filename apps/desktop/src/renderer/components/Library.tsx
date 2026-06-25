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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Meeting, MeetingSearchHit } from "@loqui/shared";
import type { LoquiLibraryApi } from "../../preload/index.js";
import {
  displayTitle,
  formatMeetingTime,
  groupMeetingsByDate,
  kindIcon,
  kindLabel,
  platformLabel,
} from "../library/grouping.js";
import { Icon } from "./Icon.js";
import { Kbd, modKeyLabel } from "../shortcuts/index.js";
import { MeetingView } from "./MeetingView.js";
import "../library/library.css";

export interface LibraryProps {
  /** Library bridge. Injectable for tests; defaults to window.loqui.library. */
  api?: LoquiLibraryApi;
  /** Reference "now" for date grouping. Injectable so tests are deterministic. */
  now?: Date;
  /**
   * One-shot ⌘F intent from the shell (PRD-16): when this counter increments,
   * focus + select the search field. 0 = no pending intent (default).
   */
  focusSearchSignal?: number;
}

/** Convert a date-input `yyyy-mm-dd` to an inclusive ISO bound, or undefined. */
function toIsoBound(value: string, end: boolean): string | undefined {
  if (!value) return undefined;
  // value is a local calendar day; widen to its start (00:00) or end (23:59:59.999).
  const d = new Date(value + (end ? "T23:59:59.999" : "T00:00:00"));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function Library({ api, now, focusSearchSignal = 0 }: LibraryProps): JSX.Element {
  const library = (api ?? window.loqui?.library) as LoquiLibraryApi | undefined;

  const searchRef = useRef<HTMLInputElement | null>(null);

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

  // "Transcribe a file" (PRD-12): open the native picker via main, import the
  // chosen file, and reload so the new kind:"import" meeting shows immediately.
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const onImportFile = useCallback(() => {
    if (!library?.pickAndImportFile) return;
    setImportError(null);
    setImporting(true);
    library
      .pickAndImportFile()
      .then((meeting) => {
        if (meeting) reload();
      })
      .catch((err: unknown) => {
        setImportError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setImporting(false));
  }, [library, reload]);

  // React to lifecycle/status pushes (e.g. an import finishing) without re-listing.
  useEffect(() => {
    if (!library?.onMeetingStatus) return;
    return library.onMeetingStatus((updated) => {
      setMeetings((prev) => {
        const exists = prev.some((m) => m.id === updated.id);
        return exists
          ? prev.map((m) => (m.id === updated.id ? updated : m))
          : [updated, ...prev];
      });
    });
  }, [library]);

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

  // ⌘F focus (PRD-16): when the shell bumps the signal, focus + select the
  // search field. The ref starts at 0 so a non-zero signal present at MOUNT
  // (the ⌘F-from-another-view case, which remounts the Library) still focuses;
  // a plain mount with signal 0 never steals focus.
  const lastFocusSignal = useRef(0);

  const groups = useMemo(() => groupMeetingsByDate(meetings, now), [meetings, now]);

  const selected = useMemo(
    () => meetings.find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId],
  );

  // When a rename returns an updated meeting, splice it into our cached list.
  const onRenamed = useCallback((updated: Meeting) => {
    setMeetings((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }, []);

  const searchActive = search.trim().length > 0;
  const filtersActive = from !== "" || to !== "";
  // UI disclosure (PRD-16 macOS-skill: "hide filters/toolbars until content
  // exists"): when the library is genuinely empty — no meetings AND no active
  // filter/search that could be hiding them — we drop the search + date controls
  // and show one calm empty state. A date filter that returns nothing keeps the
  // controls visible so the user can clear it. A load error means the true state
  // is unknown — keep the controls + surface the error, don't mask it.
  const libraryIsEmpty =
    meetings.length === 0 && !filtersActive && !searchActive && !listError && !selected;

  // ⌘F focus (PRD-16): when the shell bumps the signal, focus + select the
  // search field. The ref starts at 0 so a non-zero signal present at MOUNT (the
  // ⌘F-from-another-view case, which remounts the Library) still focuses; a
  // plain mount with signal 0 never steals focus. We depend on libraryIsEmpty so
  // that if the field isn't rendered yet (list still loading), the effect re-runs
  // once it appears — the signal is only consumed when focus actually lands.
  // Declared BEFORE the `selected` early return to keep hook order stable.
  useEffect(() => {
    if (focusSearchSignal === 0 || focusSearchSignal === lastFocusSignal.current) return;
    const el = searchRef.current;
    if (!el) return; // field not mounted yet (empty/loading/detail) — retry on next render
    lastFocusSignal.current = focusSearchSignal;
    el.focus();
    el.select();
  }, [focusSearchSignal, libraryIsEmpty]);

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

  return (
    <section className="panel library" data-testid="library" aria-labelledby="library-title">
      <h2 className="panel__title" id="library-title">
        Library
      </h2>
      <p className="panel__subtitle">Your past meetings, newest first.</p>

      {libraryIsEmpty ? (
        <LibraryEmpty
          onImportFile={onImportFile}
          importing={importing}
          canImport={Boolean(library?.pickAndImportFile)}
          importError={importError}
        />
      ) : (
        <>
          <div className="library__actions">
            <button
              type="button"
              className="library__import-btn"
              data-testid="library-import"
              onClick={onImportFile}
              disabled={importing || !library?.pickAndImportFile}
            >
              {importing ? "Importing…" : "Transcribe a file"}
            </button>
            {importError && (
              <span className="library__error" data-testid="library-import-error" role="alert">
                {importError}
              </span>
            )}
          </div>

          <div className="library__controls" data-testid="library-controls">
            <div className="library__search-wrap">
              <input
                ref={searchRef}
                type="search"
                className="library__search"
                data-testid="library-search"
                placeholder="Search transcripts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search transcripts"
              />
              {/* ⌘F hint (PRD-16): a faint tokenized chip inside the field,
                  hidden once the user starts typing so it never crowds input. */}
              {search.length === 0 && (
                <Kbd combo={`${modKeyLabel()}F`} className="library__search-kbd" />
              )}
            </div>
            <div className="library__dates">
              <label className="library__date" data-empty={from === "" ? "" : undefined}>
                <span className="library__date-label">From</span>
                <input
                  type="date"
                  data-testid="library-from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  aria-label="From date"
                />
              </label>
              <label className="library__date" data-empty={to === "" ? "" : undefined}>
                <span className="library__date-label">To</span>
                <input
                  type="date"
                  data-testid="library-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  aria-label="To date"
                />
              </label>
            </div>
          </div>
        </>
      )}

      {libraryIsEmpty ? null : listError && (
        <p className="library__error" data-testid="library-error" role="alert">
          Could not load meetings: {listError}
        </p>
      )}

      {libraryIsEmpty ? null : searchActive ? (
        <SearchResults hits={hits} searching={searching} onOpen={setSelectedId} />
      ) : (
        <GroupedList groups={groups} onOpen={setSelectedId} />
      )}
    </section>
  );
}

/**
 * The calm empty state shown when the library has no meetings at all (UI
 * disclosure — §9.11 / PRD-16): a centered line icon + a --text-subhead line + a
 * --text-caption hint + the single primary action (import a file). The search +
 * date controls are intentionally absent until meetings exist.
 */
function LibraryEmpty({
  onImportFile,
  importing,
  canImport,
  importError,
}: {
  onImportFile: () => void;
  importing: boolean;
  canImport: boolean;
  importError: string | null;
}): JSX.Element {
  return (
    <div className="library__empty-state" data-testid="library-empty-state">
      <span className="library__empty-icon" aria-hidden="true">
        <Icon name="library" size={28} />
      </span>
      <p className="library__empty-title">No meetings yet</p>
      <p className="library__empty-hint">
        Record a meeting and it lands here — searchable, with a transcript and
        summary. Or transcribe an existing audio or video file.
      </p>
      <button
        type="button"
        className="btn library__empty-action"
        data-testid="library-import"
        onClick={onImportFile}
        disabled={importing || !canImport}
      >
        {importing ? "Importing…" : "Transcribe a file"}
      </button>
      {importError && (
        <span className="library__error" data-testid="library-import-error" role="alert">
          {importError}
        </span>
      )}
    </div>
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
  // Status by EXCEPTION (DESIGN-SYSTEM §12.5): only an in-flight (processing) or
  // failed (error) meeting earns a status dot. A completed meeting shows no
  // status chrome at all. The right side collapses to ONE muted secondary line
  // — time · platform; duration moves to the meeting detail.
  const needsStatusDot = meeting.status === "processing" || meeting.status === "error";
  return (
    <li>
      <button
        type="button"
        className="library__row"
        data-testid={`library-row-${meeting.id}`}
        onClick={() => onOpen(meeting.id)}
      >
        <span className="library__row-main">
          {needsStatusDot && (
            <span
              className={`library__row-status-dot library__row-status-dot--${meeting.status}`}
              data-status={meeting.status}
              data-testid={`library-row-status-${meeting.id}`}
              aria-label={meeting.status === "processing" ? "Processing" : "Error"}
              role="img"
            >
              <Icon name="dot" size={10} />
            </span>
          )}
          <span className="library__row-title">{displayTitle(meeting)}</span>
        </span>
        <span className="library__row-meta">
          {meeting.kind !== "meeting" && (
            <span
              className={`library__row-kind library__row-kind--${meeting.kind}`}
              data-testid={`library-row-kind-${meeting.id}`}
              data-kind={meeting.kind}
            >
              {kindIcon(meeting.kind) && (
                <Icon name={kindIcon(meeting.kind)!} size={14} aria-hidden="true" />
              )}
              {kindLabel(meeting.kind)}
            </span>
          )}
          <span className="library__row-time">{formatMeetingTime(meeting.createdAt)}</span>
          <span className="library__row-sep" aria-hidden="true">
            ·
          </span>
          <span className="library__row-platform">{platformLabel(meeting.platform)}</span>
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
