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
  it("renders the Loqui home screen", () => {
    const { api } = makeFakeApi();
    render(<App api={api} />);
    expect(screen.getByRole("heading", { name: "Loqui" })).toBeTruthy();
    expect(screen.getByTestId("ping-button")).toBeTruthy();
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

  it("pings the sidecar and shows the round-trip result + latency", async () => {
    const { api } = makeFakeApi({ ping: vi.fn(async () => ({ ok: true, latencyMs: 42 })) });
    render(<App api={api} />);

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

    fireEvent.click(screen.getByTestId("ping-button"));

    await waitFor(() => {
      const result = screen.getByTestId("ping-result");
      expect(result.textContent).toContain("ping failed");
      expect(result.textContent).toContain("sidecar unreachable");
    });
  });
});
