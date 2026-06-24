/**
 * Renderer unit tests (jsdom — selected by vitest environmentMatchGlobs for
 * src/renderer/**). Hermetic: no window.loqui, no Electron, no sidecar — the
 * LoquiApi is injected as a fake via props.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { SidecarStatusBadge } from "./components/SidecarStatusBadge.js";
import type { LoquiApi, SidecarStatus } from "../preload/index.js";

afterEach(cleanup);

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
      getSummary: vi.fn(async () => null),
      getDiarizedTranscript: vi.fn(async () => null),
      renameSpeaker: vi.fn(async () => ({}) as never),
      regenerateSummary: vi.fn(async () => {}),
      setHfToken: vi.fn(async () => ({}) as never),
      getHfTokenStatus: vi.fn(async () => ({}) as never),
    },
    // PRD-7 MCP bridge: a no-op fake; the App under test does not use it yet.
    mcp: {
      status: vi.fn(async () => ({}) as never),
      enable: vi.fn(async () => ({}) as never),
      disable: vi.fn(async () => ({}) as never),
      getConfigSnippets: vi.fn(async () => []),
      onStatus: () => () => {},
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

  it("starts in the connecting state and updates when a status push arrives", async () => {
    const { api, emitStatus } = makeFakeApi();
    render(<App api={api} />);

    const badge = () => screen.getByTestId("sidecar-status");
    expect(badge().getAttribute("data-status")).toBe("connecting");

    act(() => emitStatus("connected"));
    await waitFor(() => expect(badge().getAttribute("data-status")).toBe("connected"));

    act(() => emitStatus("error"));
    await waitFor(() => expect(badge().getAttribute("data-status")).toBe("error"));
  });

  it("respects an explicit initialStatus", () => {
    const { api } = makeFakeApi();
    render(<App api={api} initialStatus="connected" />);
    expect(screen.getByTestId("sidecar-status").getAttribute("data-status")).toBe("connected");
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

    // Settings tab → CalendarSettings + MCP + Debug all mounted.
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("calendar-settings")).toBeTruthy());
    expect(screen.getByTestId("mcp-settings")).toBeTruthy();
    expect(screen.getByTestId("ping-button")).toBeTruthy();

    // Back Home.
    fireEvent.click(screen.getByTestId("nav-home"));
    await waitFor(() => expect(screen.getByTestId("home-view")).toBeTruthy());
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
