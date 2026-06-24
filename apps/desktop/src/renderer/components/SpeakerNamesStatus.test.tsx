/**
 * SpeakerNamesStatus tests (jsdom). HERMETIC: the LoquiSpeakerNamesApi is
 * injected as a controllable fake (no window.loqui, no Electron, no network).
 *
 * Covers the three connection/capture states (disconnected / connected /
 * capturing), the graceful-degradation messaging (every non-capturing state
 * says diarization still works without the extension), the one-time install
 * guidance, a live status push, and that an absent/throwing bridge renders the
 * disconnected resting state without throwing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SpeakerNamesStatus as SpeakerNamesStatusModel } from "@loqui/shared";
import { SpeakerNamesStatus } from "./SpeakerNamesStatus.js";
import type { LoquiSpeakerNamesApi } from "../../preload/index.js";

afterEach(cleanup);

const DISCONNECTED: SpeakerNamesStatusModel = {
  state: "disconnected",
  meetingActive: false,
  bufferedEvents: 0,
  lastEventAt: null,
  selectorVersion: "",
  extensionVersion: "",
};
const CONNECTED: SpeakerNamesStatusModel = {
  state: "connected",
  meetingActive: false,
  bufferedEvents: 0,
  lastEventAt: null,
  selectorVersion: "2026-06-24",
  extensionVersion: "0.1.0",
};
const CAPTURING: SpeakerNamesStatusModel = {
  state: "capturing",
  meetingActive: true,
  bufferedEvents: 42,
  lastEventAt: "2026-06-24T10:00:00.000Z",
  selectorVersion: "2026-06-24",
  extensionVersion: "0.1.0",
};

type Api = Pick<LoquiSpeakerNamesApi, "status" | "onStatus">;

function makeApi(
  initial: SpeakerNamesStatusModel = DISCONNECTED,
  overrides: Partial<Api> = {},
): { api: Api; emitStatus: (s: SpeakerNamesStatusModel) => void } {
  let cb: ((s: SpeakerNamesStatusModel) => void) | null = null;
  const api: Api = {
    status: vi.fn(async () => initial),
    onStatus: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    ...overrides,
  };
  return { api, emitStatus: (s) => cb?.(s) };
}

describe("SpeakerNamesStatus", () => {
  it("renders the title + subtitle that frame the feature as optional/best-effort", async () => {
    const { api } = makeApi();
    render(<SpeakerNamesStatus api={api} />);

    expect(screen.getByTestId("speakernames-status")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Speaker names/i })).toBeTruthy();
    const panel = screen.getByTestId("speakernames-status");
    // Subtitle reassures that diarization works regardless.
    expect(panel.textContent).toMatch(/Speaker N/);
    expect(panel.textContent).toMatch(/best-effort/i);
    // Let the async initial status() settle so the effect's setState is flushed.
    await waitFor(() => expect(api.status).toHaveBeenCalled());
  });

  it("shows the disconnected state with degradation messaging + install guidance", async () => {
    const { api } = makeApi(DISCONNECTED);
    render(<SpeakerNamesStatus api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "disconnected",
      ),
    );
    expect(screen.getByTestId("speakernames-pill").className).toContain(
      "status--disconnected",
    );
    expect(screen.getByTestId("speakernames-pill").textContent).toMatch(/not connected/i);

    // Degradation messaging: diarization still works, generic Speaker N labels.
    const detail = screen.getByTestId("speakernames-detail");
    expect(detail.textContent).toMatch(/still records|diarizes|Speaker N/i);
    expect(detail.textContent).toMatch(/Speaker N/);

    // One-time install/pairing guidance is shown when no extension is present.
    const guidance = screen.getByTestId("speakernames-guidance");
    expect(guidance).toBeTruthy();
    expect(guidance.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(guidance.textContent).toMatch(/Google Meet/i);

    // No live-capture count when not capturing.
    expect(screen.queryByTestId("speakernames-count")).toBeNull();
  });

  it("shows the connected (idle) state: paired but not capturing, no install guidance", async () => {
    const { api } = makeApi(CONNECTED);
    render(<SpeakerNamesStatus api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "connected",
      ),
    );
    expect(screen.getByTestId("speakernames-pill").className).toContain(
      "status--connecting",
    );
    expect(screen.getByTestId("speakernames-pill").textContent).toMatch(/connected/i);

    // Still reassures that diarization works either way.
    expect(screen.getByTestId("speakernames-detail").textContent).toMatch(/Speaker N/);

    // Already paired => no install guidance, no capture count.
    expect(screen.queryByTestId("speakernames-guidance")).toBeNull();
    expect(screen.queryByTestId("speakernames-count")).toBeNull();
  });

  it("shows the capturing state with a live capture count and no install guidance", async () => {
    const { api } = makeApi(CAPTURING);
    render(<SpeakerNamesStatus api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "capturing",
      ),
    );
    expect(screen.getByTestId("speakernames-pill").className).toContain(
      "status--connected",
    );
    expect(screen.getByTestId("speakernames-pill").textContent).toMatch(/Capturing/i);

    // Live capture count reflects buffered signals.
    await waitFor(() =>
      expect(screen.getByTestId("speakernames-count").textContent).toContain("42"),
    );

    // Capturing => nothing to install.
    expect(screen.queryByTestId("speakernames-guidance")).toBeNull();
  });

  it("updates the indicator on a live status push (disconnected -> capturing -> disconnected)", async () => {
    const { api, emitStatus } = makeApi(DISCONNECTED);
    render(<SpeakerNamesStatus api={api} />);

    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "disconnected",
      ),
    );

    act(() => emitStatus(CAPTURING));
    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "capturing",
      ),
    );
    expect(screen.getByTestId("speakernames-count").textContent).toContain("42");

    // Extension drops mid-meeting => back to disconnected, guidance returns, no crash.
    act(() => emitStatus(DISCONNECTED));
    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "disconnected",
      ),
    );
    expect(screen.getByTestId("speakernames-guidance")).toBeTruthy();
  });

  it("renders without a bridge (no window.loqui) as disconnected, without throwing", () => {
    expect(() => render(<SpeakerNamesStatus />)).not.toThrow();
    expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
      "disconnected",
    );
    // Degradation messaging is present even with no bridge at all.
    expect(screen.getByTestId("speakernames-detail").textContent).toMatch(/Speaker N/);
  });

  it("keeps the disconnected default when status() rejects (graceful degradation)", async () => {
    const { api } = makeApi(DISCONNECTED, {
      status: vi.fn(async () => {
        throw new Error("bridge unavailable");
      }),
    });
    expect(() => render(<SpeakerNamesStatus api={api} />)).not.toThrow();
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
      "disconnected",
    );
  });

  it("falls back to disconnected on an unrecognized/forward-incompatible state", async () => {
    const weird = {
      ...DISCONNECTED,
      state: "future-state",
    } as unknown as SpeakerNamesStatusModel;
    const { api } = makeApi(weird);
    render(<SpeakerNamesStatus api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("speakernames-pill").getAttribute("data-state")).toBe(
        "disconnected",
      ),
    );
  });

  it("STATUS-ONLY: offers no control affordance (no buttons that start/write/capture)", async () => {
    const { api } = makeApi(CONNECTED);
    render(<SpeakerNamesStatus api={api} />);
    await waitFor(() => expect(screen.getByTestId("speakernames-status")).toBeTruthy());
    expect(screen.queryAllByRole("button").length).toBe(0);
  });
});
