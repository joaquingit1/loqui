/**
 * Loqui app shell + navigation (PRD-16 — macOS-centric rehaul; built on PRD-15).
 *
 * The shell is a macOS-native layout: a left SIDEBAR (Loqui serif wordmark →
 * line-icon primary nav with an active accent pill → a bottom area with the live
 * sidecar-status badge, Settings, and a user/avatar slot) beside a scrollable
 * MAIN CONTENT region that hosts whichever view is active. The top of the window
 * is a draggable macOS title region (-webkit-app-region) and the sidebar top
 * clears the traffic-light inset.
 *
 * Phase 1 only re-houses + re-skins the shell. ALL existing functionality is
 * preserved, unchanged:
 *   - Home   — the PRD-15 Today/Upcoming calendar view (landing); "join &
 *              record" starts a meeting and switches to the Meeting view.
 *   - Meeting— the in-meeting controls + live transcript + in-call chat
 *              (PRD-2/3/4) and post-processing (PRD-5).
 *   - Library— the dated/searchable list of past meetings (PRD-3).
 *   - Settings—Calendar (PRD-15) + Speaker names (PRD-6) + Transcription (PRD-9)
 *              + Privacy/Export (PRD-13) + Agent/MCP (PRD-7) + the ping Debug.
 *
 * The renderer ONLY talks to the typed window.loqui bridge — never to ipc
 * channels or Node globals directly. View internals are NOT rewritten here
 * (later phases); they render inside the new shell as-is.
 */
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { Meeting, StartMeetingParams } from "@loqui/shared";
import type { LoquiApi, SidecarStatus } from "../preload/index.js";
import { Icon, type IconName } from "./components/Icon.js";
import { useKeyboardShortcuts, type Shortcut } from "./shortcuts/index.js";
import { DebugPanel } from "./components/DebugPanel.js";
import { MeetingControls } from "./components/MeetingControls.js";
import { Library } from "./components/Library.js";
import { MeetingView } from "./components/MeetingView.js";
import { McpSettings } from "./components/McpSettings.js";
import { PrivacyExportSettings } from "./components/PrivacyExportSettings.js";
import { TranscriptionSettings } from "./components/TranscriptionSettings.js";
import { HomeView } from "./components/HomeView.js";
import { CalendarSettings } from "./components/CalendarSettings.js";
import { SpeakerNamesStatus } from "./components/SpeakerNamesStatus.js";
import { displayTitle, formatMeetingTime } from "./library/grouping.js";

declare global {
  interface Window {
    loqui: LoquiApi;
  }
}

export type { SidecarStatus };

/**
 * The top-level navigable views. "detail" is the past-meeting summary + chat
 * surface opened from the sidebar RECENTS list (it has no primary-nav button).
 */
export type AppView = "home" | "meeting" | "library" | "settings" | "detail";

/** How many recent past meetings the sidebar surfaces. */
const RECENTS_LIMIT = 8;

/** Short date label for a recents row (e.g. "Jun 24"), with a clock fallback. */
function recentDateLabel(meeting: Meeting): string {
  const d = new Date(meeting.createdAt);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? formatMeetingTime(meeting.createdAt)
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface AppProps {
  /** Injectable for tests; defaults to the contextBridge-exposed window.loqui. */
  api?: LoquiApi;
  /** Initial status before the first push arrives. */
  initialStatus?: SidecarStatus;
  /** Initial view; defaults to Home (the landing view). Injectable for tests. */
  initialView?: AppView;
}

const NAV: ReadonlyArray<{ view: AppView; label: string; icon: IconName }> = [
  { view: "home", label: "Home", icon: "home" },
  { view: "meeting", label: "Meeting", icon: "mic" },
  { view: "library", label: "Library", icon: "library" },
];

function NavItem({
  view,
  label,
  icon,
  active,
  onClick,
}: {
  view: AppView;
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`nav-item ${active ? "nav-item--active" : ""}`}
      data-testid={`nav-${view}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="nav-item__icon">
        <Icon name={icon} />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function App({
  api,
  initialStatus = "connecting",
  initialView = "home",
}: AppProps): JSX.Element {
  const [status, setStatus] = useState<SidecarStatus>(initialStatus);
  const [view, setView] = useState<AppView>(initialView);
  // RECENTS: the dated list of past meetings surfaced in the sidebar. Loaded
  // from window.loqui.library.listMeetings (newest-first) and kept in sync with
  // lifecycle pushes (a finished/imported meeting appears without a re-list).
  const [recents, setRecents] = useState<Meeting[]>([]);
  // The past meeting opened from a RECENTS row (summary + chat-below detail).
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  // Cross-view shortcut signals (PRD-16 macOS-skill compliance): bumping a
  // counter is a one-shot intent the active child consumes via an effect — keeps
  // the keyboard handler in the shell while the action stays in its component.
  // ⌘N → switch to Meeting + auto-start; ⌘F → focus the Library search field.
  // A pending "start a recording" request (with optional prefill) handed to the
  // MeetingControls controller — the SINGLE owner of startMeeting + capture, so
  // the meeting id / capture / live transcript never diverge across entry points.
  const [pendingStart, setPendingStart] = useState<StartMeetingParams | null>(null);
  const [librarySearchSignal, setLibrarySearchSignal] = useState(0);
  // The workspace switcher is not built yet — clicking it briefly shows a
  // "Coming soon" hint instead of leaving a dead control.
  const [workspaceSoon, setWorkspaceSoon] = useState(false);
  useEffect(() => {
    if (!workspaceSoon) return;
    const t = setTimeout(() => setWorkspaceSoon(false), 2400);
    return () => clearTimeout(t);
  }, [workspaceSoon]);

  useEffect(() => {
    const loqui = api ?? (typeof window !== "undefined" ? window.loqui : undefined);
    // window.loqui is absent in non-Electron contexts (e.g. plain unit render);
    // guard so the home screen still renders its initial status.
    if (!loqui?.onSidecarStatus) return;
    const unsubscribe = loqui.onSidecarStatus(setStatus);
    return unsubscribe;
  }, [api]);

  // Load the recents list (READ-ONLY listMeetings) for the sidebar.
  const library = api?.library ?? (typeof window !== "undefined" ? window.loqui?.library : undefined);
  useEffect(() => {
    if (!library?.listMeetings) return;
    let cancelled = false;
    library
      .listMeetings()
      .then((meetings) => {
        if (!cancelled) setRecents(meetings);
      })
      .catch(() => {
        /* leave recents empty; the full Library view still works */
      });
    return () => {
      cancelled = true;
    };
  }, [library]);

  // Keep recents fresh on lifecycle pushes (finished/imported/renamed meetings)
  // without a re-list — mirrors what the Library view does for its own list.
  useEffect(() => {
    if (!library?.onMeetingStatus) return;
    return library.onMeetingStatus((updated) => {
      setRecents((prev) => {
        const exists = prev.some((m) => m.id === updated.id);
        return exists
          ? prev.map((m) => (m.id === updated.id ? updated : m))
          : [updated, ...prev];
      });
      // Keep an open detail in sync with its latest meeting record.
      setSelectedMeeting((cur) => (cur && cur.id === updated.id ? updated : cur));
    });
  }, [library]);

  const recentsList = useMemo(() => recents.slice(0, RECENTS_LIMIT), [recents]);

  // Start a recording from ANY entry point — Home "Start a meeting", a calendar
  // "join & record" (with the event prefill), or ⌘N — by handing the intent to
  // the Meeting view. MeetingControls' controller then does the ATOMIC
  // startMeeting + capture, so capture always begins and the live transcript's
  // meetingId is always the id actually being transcribed (no divergence).
  const requestStart = useCallback((params?: StartMeetingParams) => {
    setSelectedMeeting(null);
    setPendingStart(params ?? {});
    setView("meeting");
  }, []);

  // Open a past meeting's detail (summary + chat-below) from a RECENTS row.
  const onOpenMeeting = useCallback((meeting: Meeting) => {
    setSelectedMeeting(meeting);
    setView("detail");
  }, []);

  // A rename inside the detail lifts the updated meeting back so the sidebar row
  // (and the open detail) reflect the new title without a re-list.
  const onMeetingRenamed = useCallback((updated: Meeting) => {
    setRecents((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    setSelectedMeeting((cur) => (cur && cur.id === updated.id ? updated : cur));
  }, []);

  // A delete drops the meeting from the sidebar recents and, if it was the open
  // detail, closes it back to Home (it no longer exists).
  const onMeetingDeleted = useCallback((meetingId: string) => {
    setRecents((prev) => prev.filter((m) => m.id !== meetingId));
    setSelectedMeeting((cur) => {
      if (cur && cur.id === meetingId) {
        setView((v) => (v === "detail" ? "home" : v));
        return null;
      }
      return cur;
    });
  }, []);

  // Navigate to a primary view (also clears any open detail), shared by the nav
  // buttons and the ⌘1/2/3/, shortcuts so both paths behave identically.
  const goTo = useCallback((v: AppView) => {
    setSelectedMeeting(null);
    setView(v);
  }, []);

  // Esc returns from an open meeting detail to Home (the export menu + rename
  // own their own local Esc; this is the shell-level "back out of detail").
  const onEscape = useCallback(() => {
    setView((cur) => {
      if (cur === "detail") {
        setSelectedMeeting(null);
        return "home";
      }
      return cur;
    });
  }, []);

  // ⌘N: jump to the Meeting view and auto-start a recording (one-shot signal the
  // MeetingControls consumes). ⌘F: focus the Library search (navigates there if
  // needed, then bumps a signal the Library focuses on).
  const onStartMeetingShortcut = useCallback(() => requestStart(), [requestStart]);
  const onFocusSearchShortcut = useCallback(() => {
    setSelectedMeeting(null);
    setView("library");
    setLibrarySearchSignal((n) => n + 1);
  }, []);

  // macOS-correct primary-action shortcuts (⌘ on macOS / Ctrl elsewhere — the
  // hook detects the platform). Plain typing is never hijacked; Esc always fires.
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      { key: "1", mod: true, run: () => goTo("home") },
      { key: "2", mod: true, run: () => goTo("meeting") },
      { key: "3", mod: true, run: () => goTo("library") },
      { key: ",", mod: true, run: () => goTo("settings") },
      { key: "n", mod: true, run: onStartMeetingShortcut },
      { key: "f", mod: true, run: onFocusSearchShortcut },
      { key: "Escape", run: onEscape },
    ],
    [goTo, onStartMeetingShortcut, onFocusSearchShortcut, onEscape],
  );
  useKeyboardShortcuts(shortcuts);

  let content: ReactNode;
  if (view === "detail" && selectedMeeting) {
    content = (
      <MeetingView
        meeting={selectedMeeting}
        api={api?.library}
        exportApi={api?.export}
        chatApi={api?.chat}
        onBack={() => setView("home")}
        onRenamed={onMeetingRenamed}
        onDeleted={onMeetingDeleted}
      />
    );
  } else if (view === "home") {
    content = (
      <HomeView
        calendar={api?.calendar}
        onOpenSettings={() => setView("settings")}
        onOpenLibrary={() => setView("library")}
        onStartMeeting={requestStart}
      />
    );
  } else if (view === "meeting") {
    content = (
      <MeetingControls
        api={api}
        sidecarStatus={status}
        pendingStart={pendingStart}
        onPendingStartConsumed={() => setPendingStart(null)}
      />
    );
  } else if (view === "library") {
    content = (
      <Library
        api={api?.library}
        focusSearchSignal={librarySearchSignal}
        onDeleted={onMeetingDeleted}
      />
    );
  } else {
    content = (
      <>
        <CalendarSettings api={api?.calendar} />
        <SpeakerNamesStatus api={api?.speakerNames} />
        <TranscriptionSettings api={api?.transcription} />
        <PrivacyExportSettings privacy={api?.privacy} exportApi={api?.export} />
        <McpSettings api={api?.mcp} />
        <DebugPanel api={api} />
      </>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <h1 className="sidebar__wordmark">Loqui</h1>
        </div>

        <nav className="sidebar__nav" aria-label="Primary" data-testid="app-nav">
          {NAV.map(({ view: v, label, icon }) => (
            <NavItem
              key={v}
              view={v}
              label={label}
              icon={icon}
              active={view === v}
              onClick={() => goTo(v)}
            />
          ))}
        </nav>

        {recentsList.length > 0 && (
          <div className="sidebar__recents" data-testid="sidebar-recents">
            <p className="sidebar__eyebrow">Recents</p>
            <ul className="sidebar__recents-list">
              {recentsList.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className={`recent-item ${
                      view === "detail" && selectedMeeting?.id === m.id
                        ? "recent-item--active"
                        : ""
                    }`}
                    data-testid={`recent-${m.id}`}
                    aria-current={
                      view === "detail" && selectedMeeting?.id === m.id ? "page" : undefined
                    }
                    onClick={() => onOpenMeeting(m)}
                  >
                    <span className="recent-item__title">{displayTitle(m)}</span>
                    <span className="recent-item__meta">{recentDateLabel(m)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="sidebar__spacer" />

        <div className="sidebar__foot">
          <NavItem
            view="settings"
            label="Settings"
            icon="settings"
            active={view === "settings"}
            onClick={() => goTo("settings")}
          />
          <button
            type="button"
            className="sidebar__user"
            data-testid="sidebar-workspace"
            title="Workspaces — coming soon"
            aria-label="Workspace switcher (coming soon)"
            onClick={() => setWorkspaceSoon(true)}
          >
            <span className="avatar" aria-hidden="true">
              L
            </span>
            <span className="sidebar__user-name">
              {workspaceSoon ? "Coming soon" : "Local workspace"}
            </span>
            <span className="sidebar__user-chevron">
              <Icon name="chevron-down" size={16} />
            </span>
          </button>
        </div>
      </aside>

      <main className="app__main">
        <div className="app__main-drag" aria-hidden="true" />
        <div className="app__content">{content}</div>
      </main>
    </div>
  );
}
