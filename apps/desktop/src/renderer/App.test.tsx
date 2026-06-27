/**
 * Renderer unit tests (jsdom — selected by vitest environmentMatchGlobs for
 * src/renderer/**). Hermetic: no window.loqui, no Electron, no sidecar — the
 * LoquiApi is injected as a fake via props.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Meeting } from "@loqui/shared";
import { App } from "./App.js";
import { SidecarStatusBadge } from "./components/SidecarStatusBadge.js";
import { isMacPlatform } from "./shortcuts/index.js";
import type { LoquiApi, SidecarStatus } from "../preload/index.js";

afterEach(cleanup);

/** A couple of past meetings the sidebar RECENTS list can surface. */
const RECENT_A: Meeting = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "Sprint planning",
  platform: "teams",
  startedAt: "2026-06-23T14:00:00Z",
  endedAt: "2026-06-23T14:30:00Z",
  status: "done",
  kind: "meeting",
  participants: [],
  modelVersions: {},
  calendarAttendees: [],
  titleEdited: false,
  createdAt: "2026-06-23T14:00:00",
  updatedAt: "2026-06-23T14:30:00",
};
const RECENT_B: Meeting = {
  ...RECENT_A,
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  title: "Design review",
  createdAt: "2026-06-22T10:00:00",
};

/** A controllable fake of the contextBridge LoquiApi. */
function makeFakeApi(overrides: Partial<LoquiApi> = {}): {
  api: LoquiApi;
  emitStatus: (s: SidecarStatus) => void;
} {
  let cb: ((s: SidecarStatus) => void) | null = null;
  const api: LoquiApi = {
    ping: vi.fn(async () => ({ ok: true, latencyMs: 7 })),
    getSidecarHealth: vi.fn(async () => null),
    onSidecarStatus: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    // PRD-1 audio bridge: a no-op fake; the App under test does not call it yet.
    audio: {
      startCapture: vi.fn(async () => ({ ok: true })),
      stopCapture: vi.fn(async () => ({ ok: true })),
      sendFrame: vi.fn(),
      getScreenPermission: vi.fn(async () => "not-applicable" as const),
      onScreenPermission: () => () => {},
    },
    // PRD-2 transcript bridge: a no-op fake; the App under test does not use it yet.
    onTranscriptSegment: () => () => {},
    // PRD-3 library/lifecycle bridge: a no-op fake; the App under test does not use it yet.
    library: {
      startMeeting: vi.fn(async () => ({}) as never),
      stopMeeting: vi.fn(async () => ({}) as never),
      listMeetings: vi.fn(async () => []),
      searchMeetings: vi.fn(async () => []),
      getTranscript: vi.fn(async () => ""),
      renameMeeting: vi.fn(async () => ({}) as never),
      deleteMeeting: vi.fn(async () => {}),
      importFile: vi.fn(async () => ({}) as never),
      pickAndImportFile: vi.fn(async () => null),
      onMeetingStatus: () => () => {},
    },
    // PRD-4 chat bridge: a no-op fake; the App under test does not use it yet.
    chat: {
      send: vi.fn(),
      onStream: () => () => {},
      getProviderSettings: vi.fn(async () => ({}) as never),
      setProviderSettings: vi.fn(async () => ({}) as never),
      setApiKey: vi.fn(async () => ({}) as never),
      getApiKeyStatus: vi.fn(async () => ({}) as never),
    },
    // PRD-5 postprocess bridge: a no-op fake; the App under test does not use it yet.
    postprocess: {
      onJob: () => () => {},
      onSummaryToken: () => () => {},
      getSummary: vi.fn(async () => null),
      getDiarizedTranscript: vi.fn(async () => null),
      renameSpeaker: vi.fn(async () => ({}) as never),
      regenerateSummary: vi.fn(async () => {}),
      setHfToken: vi.fn(async () => ({}) as never),
      getHfTokenStatus: vi.fn(async () => ({}) as never),
      setDiarizationBackend: vi.fn(async () => ({}) as never),
      getDiarizationBackendStatus: vi.fn(async () => ({}) as never),
    },
    // PRD-15 calendar bridge: a no-op fake; the App under test does not use it yet.
    calendar: {
      listToday: vi.fn(async () => []),
      listUpcoming: vi.fn(async () => []),
      connect: vi.fn(async () => ({ connected: false })),
      disconnect: vi.fn(async () => {}),
      getConnections: vi.fn(async () => []),
      refresh: vi.fn(async () => []),
      onUpdated: () => () => {},
    },
    // PRD-11 auto-record bridge: a no-op fake; the current user-facing toggle is
    // in the tray; renderer Settings arrive with the UI rehaul. Returns the
    // disabled resting settings/state so any incidental read is well-formed.
    autoRecord: {
      getSettings: vi.fn(async () => ({}) as never),
      setSettings: vi.fn(async () => ({}) as never),
      getState: vi.fn(async () => ({}) as never),
      acceptPending: vi.fn(async () => {}),
      dismissPending: vi.fn(async () => {}),
      onState: () => () => {},
    },
    // PRD-13 export bridge: a no-op fake; the App under test does not exercise it
    // directly (it is reached from the library/meeting panels).
    export: {
      exportMeeting: vi.fn(async () => ({}) as never),
    },
    // PRD-8 updater bridge: a no-op fake; the App under test does not exercise it
    // directly (Settings + the restart prompt arrive with the UI rehaul).
    updater: {
      getState: vi.fn(async () => ({}) as never),
      getSettings: vi.fn(async () => ({}) as never),
      setSettings: vi.fn(async () => ({}) as never),
      checkNow: vi.fn(async () => ({}) as never),
      quitAndInstall: vi.fn(async () => {}),
      onState: () => () => {},
    },
    // "Meeting Detected" popup bridge: no-op fakes (the popup is its own window).
    notifications: {
      onMeetingDetected: () => () => {},
      join: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {}),
    },
    onStartRequest: () => () => {},
    ...overrides,
  };
  return { api, emitStatus: (s) => cb?.(s) };
}

describe("SidecarStatusBadge", () => {
  const cases: Array<[SidecarStatus, string]> = [
    ["connected", "Connected"],
    ["connecting", "Starting"],
    ["disconnected", "Disconnected"],
    ["error", "Error"],
  ];

  it.each(cases)("renders the %s state with a matching class + label", (status, label) => {
    render(<SidecarStatusBadge status={status} />);
    const badge = screen.getByTestId("sidecar-status");
    expect(badge.getAttribute("data-status")).toBe(status);
    expect(badge.className).toContain(`status--${status}`);
    expect(badge.textContent).toContain(label);
  });
});

describe("App", () => {
  it("renders the Loqui home screen as the landing view", () => {
    const { api } = makeFakeApi();
    render(<App api={api} />);
    expect(screen.getByRole("heading", { name: "Loqui" })).toBeTruthy();
    // Home is the landing view; the nav shell + Today view are mounted.
    expect(screen.getByTestId("app-nav")).toBeTruthy();
    expect(screen.getByTestId("home-view")).toBeTruthy();
  });

  it("subscribes to sidecar status pushes but no longer shows a status badge in the shell", () => {
    const { api, emitStatus } = makeFakeApi();
    render(<App api={api} />);

    // The sidecar status indicator was intentionally removed from the sidebar.
    expect(screen.queryByTestId("sidecar-status")).toBeNull();

    // App still subscribes to status pushes (consumed by the Meeting view) —
    // emitting must not throw and must not resurrect a shell badge.
    act(() => emitStatus("connected"));
    act(() => emitStatus("error"));
    expect(screen.getByTestId("home-view")).toBeTruthy();
    expect(screen.queryByTestId("sidecar-status")).toBeNull();
  });

  it("the workspace switcher shows a 'coming soon' hint on click (not a dead control)", () => {
    const { api } = makeFakeApi();
    render(<App api={api} />);
    const ws = screen.getByTestId("sidebar-workspace");
    expect(ws.textContent).toContain("Local workspace");
    fireEvent.click(ws);
    expect(screen.getByTestId("sidebar-workspace").textContent).toContain("Coming soon");
  });

  it("navigates Home ↔ Library ↔ Meeting and keeps the existing views reachable", async () => {
    const { api } = makeFakeApi();
    render(<App api={api} />);

    // Landing = Home.
    expect(screen.getByTestId("home-view")).toBeTruthy();

    // Library tab → the existing past-meetings Library.
    fireEvent.click(screen.getByTestId("nav-library"));
    await waitFor(() => expect(screen.getByTestId("library")).toBeTruthy());

    // Meeting tab → the existing MeetingControls (Start meeting).
    fireEvent.click(screen.getByTestId("nav-meeting"));
    await waitFor(() => expect(screen.getByTestId("meeting-controls")).toBeTruthy());

    // Settings tab → CalendarSettings + Debug mounted. (No MCP panel — the local
    // MCP server is always-on and headless, with no Settings surface.)
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("calendar-settings")).toBeTruthy());
    expect(screen.queryByTestId("mcp-settings")).toBeNull();
    expect(screen.getByTestId("ping-button")).toBeTruthy();

    // Back Home.
    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(screen.getByTestId("home-view")).toBeTruthy());
  });

  it("surfaces recent past meetings in the sidebar (RECENTS), dated + clickable", async () => {
    const listMeetings = vi.fn(async () => [RECENT_A, RECENT_B]);
    const { api } = makeFakeApi({
      library: {
        startMeeting: vi.fn(async () => ({}) as never),
        stopMeeting: vi.fn(async () => ({}) as never),
        listMeetings,
        searchMeetings: vi.fn(async () => []),
        getTranscript: vi.fn(async () => ""),
        renameMeeting: vi.fn(async () => ({}) as never),
      deleteMeeting: vi.fn(async () => {}),
        importFile: vi.fn(async () => ({}) as never),
        pickAndImportFile: vi.fn(async () => null),
        onMeetingStatus: () => () => {},
      },
    });
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByTestId("sidebar-recents")).toBeTruthy());
    expect(listMeetings).toHaveBeenCalled();
    const recents = screen.getByTestId("sidebar-recents");
    expect(recents.textContent).toContain("Sprint planning");
    expect(recents.textContent).toContain("Design review");
    expect(screen.getByTestId(`recent-${RECENT_A.id}`)).toBeTruthy();
  });

  it("opens a recent's detail (summary + chat-below) and returns Home", async () => {
    const getTranscript = vi.fn(async () => "[00:00:01] You said: Hi\n");
    const { api } = makeFakeApi({
      library: {
        startMeeting: vi.fn(async () => ({}) as never),
        stopMeeting: vi.fn(async () => ({}) as never),
        listMeetings: vi.fn(async () => [RECENT_A]),
        searchMeetings: vi.fn(async () => []),
        getTranscript,
        renameMeeting: vi.fn(async () => ({}) as never),
      deleteMeeting: vi.fn(async () => {}),
        importFile: vi.fn(async () => ({}) as never),
        pickAndImportFile: vi.fn(async () => null),
        onMeetingStatus: () => () => {},
      },
    });
    render(<App api={api} />);

    await waitFor(() => expect(screen.getByTestId(`recent-${RECENT_A.id}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`recent-${RECENT_A.id}`));

    // The past-meeting detail = the MeetingView (summary) + the chat panel below.
    await waitFor(() => expect(screen.getByTestId("meeting-view")).toBeTruthy());
    expect(getTranscript).toHaveBeenCalledWith({ id: RECENT_A.id, variant: "live" });
    expect(screen.getByTestId("summary-view")).toBeTruthy();
    expect(screen.getByTestId("meeting-chat")).toBeTruthy();
    expect(screen.getByTestId("chat-panel")).toBeTruthy();

    // Back leaves the detail and returns to Home.
    fireEvent.click(screen.getByTestId("meeting-back"));
    await waitFor(() => expect(screen.getByTestId("home-view")).toBeTruthy());
    expect(screen.queryByTestId("meeting-view")).toBeNull();
  });

  // PRD-16 macOS-skill compliance: primary-action keyboard shortcuts wired in
  // the shell. The App detects the platform at runtime; under jsdom that's
  // non-mac, so we press the PLATFORM-correct primary modifier (Ctrl here) to
  // match what the shell binds — the same detection drives the visible glyphs.
  function pressMeta(key: string): void {
    const mac = isMacPlatform();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  describe("keyboard shortcuts", () => {
    it("navigates with ⌘1 Home · ⌘2 Meeting · ⌘3 Library · ⌘, Settings", async () => {
      const { api } = makeFakeApi();
      render(<App api={api} initialView="home" />);
      expect(screen.getByTestId("home-view")).toBeTruthy();

      act(() => pressMeta("3"));
      await waitFor(() => expect(screen.getByTestId("library")).toBeTruthy());

      act(() => pressMeta("2"));
      await waitFor(() => expect(screen.getByTestId("meeting-controls")).toBeTruthy());

      act(() => pressMeta(","));
      await waitFor(() => expect(screen.getByTestId("calendar-settings")).toBeTruthy());

      act(() => pressMeta("1"));
      await waitFor(() => expect(screen.getByTestId("home-view")).toBeTruthy());
    });

    it("⌘F jumps to the Library and focuses its search field", async () => {
      const { api } = makeFakeApi({
        library: {
          startMeeting: vi.fn(async () => ({}) as never),
          stopMeeting: vi.fn(async () => ({}) as never),
          listMeetings: vi.fn(async () => [RECENT_A]),
          searchMeetings: vi.fn(async () => []),
          getTranscript: vi.fn(async () => ""),
          renameMeeting: vi.fn(async () => ({}) as never),
      deleteMeeting: vi.fn(async () => {}),
          importFile: vi.fn(async () => ({}) as never),
          pickAndImportFile: vi.fn(async () => null),
          onMeetingStatus: () => () => {},
        },
      });
      render(<App api={api} initialView="home" />);

      act(() => pressMeta("f"));
      await waitFor(() => expect(screen.getByTestId("library-search")).toBeTruthy());
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByTestId("library-search")),
      );
    });

    it("Esc backs out of an open meeting detail to Home", async () => {
      const { api } = makeFakeApi({
        library: {
          startMeeting: vi.fn(async () => ({}) as never),
          stopMeeting: vi.fn(async () => ({}) as never),
          listMeetings: vi.fn(async () => [RECENT_A]),
          searchMeetings: vi.fn(async () => []),
          getTranscript: vi.fn(async () => ""),
          renameMeeting: vi.fn(async () => ({}) as never),
      deleteMeeting: vi.fn(async () => {}),
          importFile: vi.fn(async () => ({}) as never),
          pickAndImportFile: vi.fn(async () => null),
          onMeetingStatus: () => () => {},
        },
      });
      render(<App api={api} />);

      await waitFor(() => expect(screen.getByTestId(`recent-${RECENT_A.id}`)).toBeTruthy());
      fireEvent.click(screen.getByTestId(`recent-${RECENT_A.id}`));
      await waitFor(() => expect(screen.getByTestId("meeting-view")).toBeTruthy());

      act(() =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
      );
      await waitFor(() => expect(screen.getByTestId("home-view")).toBeTruthy());
      expect(screen.queryByTestId("meeting-view")).toBeNull();
    });
  });

  it("pings the sidecar (Debug panel under Settings) and shows the round-trip result", async () => {
    const { api } = makeFakeApi({ ping: vi.fn(async () => ({ ok: true, latencyMs: 42 })) });
    render(<App api={api} />);

    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("ping-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ping-button"));

    await waitFor(() => expect(screen.getByTestId("ping-result")).toBeTruthy());
    const result = screen.getByTestId("ping-result");
    expect(result.textContent).toContain("pong");
    expect(result.textContent).toContain("42 ms");
    expect(api.ping).toHaveBeenCalledTimes(1);
  });

  it("surfaces a ping failure instead of throwing", async () => {
    const { api } = makeFakeApi({
      ping: vi.fn(async () => {
        throw new Error("sidecar unreachable");
      }),
    });
    render(<App api={api} />);

    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("ping-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ping-button"));

    await waitFor(() => {
      const result = screen.getByTestId("ping-result");
      expect(result.textContent).toContain("ping failed");
      expect(result.textContent).toContain("sidecar unreachable");
    });
  });
});
