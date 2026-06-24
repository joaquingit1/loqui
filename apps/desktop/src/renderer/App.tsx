/**
 * Loqui app shell + navigation (PRD-15).
 *
 * Restructures the former single-screen layout into a minimal nav shell with
 * four reachable views, keeping ALL existing functionality:
 *   - Home   — the PRD-15 Today/Upcoming calendar view (landing); "join &
 *              record" starts a meeting and switches to the Meeting view.
 *   - Meeting— the in-meeting controls + live transcript + in-call chat
 *              (PRD-2/3/4) and post-processing (PRD-5). The "Start meeting"
 *              affordance lives here.
 *   - Library— the dated/searchable list of past meetings (PRD-3), which opens
 *              the per-meeting MeetingView (summary/diarized transcript).
 *   - Settings—Calendar connections (PRD-15) + Agent access / MCP (PRD-7) + the
 *              ping Debug panel.
 *
 * The header carries the app title, the live sidecar-status badge (driven by
 * window.loqui.onSidecarStatus), and the nav tabs.
 *
 * The renderer ONLY talks to the typed window.loqui bridge — never to ipc
 * channels or Node globals directly.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { Meeting } from "@loqui/shared";
import type { LoquiApi, SidecarStatus } from "../preload/index.js";
import { SidecarStatusBadge } from "./components/SidecarStatusBadge.js";
import { DebugPanel } from "./components/DebugPanel.js";
import { MeetingControls } from "./components/MeetingControls.js";
import { Library } from "./components/Library.js";
import { McpSettings } from "./components/McpSettings.js";
import { HomeView } from "./components/HomeView.js";
import { CalendarSettings } from "./components/CalendarSettings.js";
import { SpeakerNamesStatus } from "./components/SpeakerNamesStatus.js";

declare global {
  interface Window {
    loqui: LoquiApi;
  }
}

export type { SidecarStatus };

/** The top-level navigable views. */
export type AppView = "home" | "meeting" | "library" | "settings";

export interface AppProps {
  /** Injectable for tests; defaults to the contextBridge-exposed window.loqui. */
  api?: LoquiApi;
  /** Initial status before the first push arrives. */
  initialStatus?: SidecarStatus;
  /** Initial view; defaults to Home (the landing view). Injectable for tests. */
  initialView?: AppView;
}

const NAV: ReadonlyArray<{ view: AppView; label: string }> = [
  { view: "home", label: "Home" },
  { view: "meeting", label: "Meeting" },
  { view: "library", label: "Library" },
  { view: "settings", label: "Settings" },
];

export function App({
  api,
  initialStatus = "connecting",
  initialView = "home",
}: AppProps): JSX.Element {
  const [status, setStatus] = useState<SidecarStatus>(initialStatus);
  const [view, setView] = useState<AppView>(initialView);

  useEffect(() => {
    const loqui = api ?? (typeof window !== "undefined" ? window.loqui : undefined);
    // window.loqui is absent in non-Electron contexts (e.g. plain unit render);
    // guard so the home screen still renders its initial status.
    if (!loqui?.onSidecarStatus) return;
    const unsubscribe = loqui.onSidecarStatus(setStatus);
    return unsubscribe;
  }, [api]);

  // "Join & record" from Home creates a meeting then hands it here so we switch
  // to the active-meeting view. The MeetingControls component owns the meeting
  // lifecycle/UI; the new meeting surfaces there via the lifecycle bridge.
  const onMeetingStarted = useCallback((_meeting: Meeting) => {
    setView("meeting");
  }, []);

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Loqui</h1>
          <p className="app__tagline">Local-first meeting transcription.</p>
        </div>
        <SidecarStatusBadge status={status} />
      </header>

      <nav className="app__nav" aria-label="Primary" data-testid="app-nav">
        {NAV.map(({ view: v, label }) => (
          <button
            key={v}
            type="button"
            className={`app__nav-tab ${view === v ? "app__nav-tab--active" : ""}`}
            data-testid={`nav-${v}`}
            aria-current={view === v ? "page" : undefined}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </nav>

      {view === "home" && (
        <HomeView
          calendar={api?.calendar}
          library={api?.library}
          onOpenSettings={() => setView("settings")}
          onMeetingStarted={onMeetingStarted}
        />
      )}

      {view === "meeting" && <MeetingControls api={api} sidecarStatus={status} />}

      {view === "library" && <Library api={api?.library} />}

      {view === "settings" && (
        <>
          <CalendarSettings api={api?.calendar} />
          <SpeakerNamesStatus api={api?.speakerNames} />
          <McpSettings api={api?.mcp} />
          <DebugPanel api={api} />
        </>
      )}
    </main>
  );
}
