/**
 * CalendarSettings tests (jsdom). HERMETIC: the calendar bridge is injected as a
 * controllable fake (no window.loqui, no IPC, no network). Covers: a row per
 * provider with the read-only-scope explainer; Connect calls connect(provider)
 * and reflects the resulting connected account + last-sync; Disconnect calls
 * disconnect(provider, account) and clears the row; a failed connect surfaces an
 * error; and the read-only framing is present (no calendar-write affordance).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CalendarConnection } from "@loqui/shared";
import { CalendarSettings } from "./CalendarSettings.js";
import type { LoquiCalendarApi } from "../../preload/index.js";

afterEach(cleanup);

type CalApi = Pick<LoquiCalendarApi, "connect" | "disconnect" | "getConnections" | "onUpdated">;

function makeApi(
  initial: CalendarConnection[] = [],
  overrides: Partial<CalApi> = {},
): { api: CalApi; connections: CalendarConnection[] } {
  // A mutable store so connect/disconnect change what getConnections returns.
  const store = { list: [...initial] };
  const api: CalApi = {
    getConnections: vi.fn(async () => store.list),
    connect: vi.fn(async (provider) => {
      const account = `${provider}@example.com`;
      store.list = [
        ...store.list,
        { provider, account, lastSyncAt: "2026-06-24T08:00:00.000Z" },
      ];
      return { connected: true, account };
    }),
    disconnect: vi.fn(async (provider, account) => {
      store.list = store.list.filter(
        (c) => !(c.provider === provider && (account === undefined || c.account === account)),
      );
    }),
    onUpdated: () => () => {},
    ...overrides,
  };
  return { api, connections: store.list };
}

describe("CalendarSettings", () => {
  it("renders a row per provider with the read-only scope explainer", async () => {
    const { api } = makeApi();
    render(<CalendarSettings api={api} />);

    expect(screen.getByTestId("calendar-settings")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Calendars" })).toBeTruthy();
    expect(screen.getByTestId("calendar-provider-google")).toBeTruthy();
    expect(screen.getByTestId("calendar-provider-microsoft")).toBeTruthy();
    expect(screen.getByTestId("calendar-provider-zoom")).toBeTruthy();

    const panel = screen.getByTestId("calendar-settings");
    expect(panel.textContent).toMatch(/read-only/i);
    // Per-provider scope copy.
    expect(screen.getByTestId("calendar-provider-google").textContent).toMatch(
      /calendar\.events\.readonly/,
    );
    expect(screen.getByTestId("calendar-provider-microsoft").textContent).toMatch(/Calendars\.Read/);
    expect(screen.getByTestId("calendar-provider-zoom").textContent).toMatch(/meeting:read/);

    // All three start disconnected with a Connect button.
    await waitFor(() => expect(screen.getByTestId("calendar-connect-google")).toBeTruthy());
  });

  it("connects a provider and shows the account + last sync", async () => {
    const onChanged = vi.fn();
    const { api } = makeApi([], {});
    render(<CalendarSettings api={api} onConnectionsChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId("calendar-connect-google")).toBeTruthy());

    fireEvent.click(screen.getByTestId("calendar-connect-google"));

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith("google"));
    await waitFor(() =>
      expect(screen.getByTestId("calendar-account-google-google@example.com")).toBeTruthy(),
    );
    expect(screen.getByTestId("calendar-account-status-google").textContent).toContain(
      "google@example.com",
    );
    // Sync label rendered.
    expect(
      screen.getByTestId("calendar-account-google-google@example.com").textContent,
    ).toMatch(/Synced/);
    // The Connect button is replaced by Disconnect for that provider.
    expect(screen.queryByTestId("calendar-connect-google")).toBeNull();
    expect(screen.getByTestId("calendar-disconnect-google")).toBeTruthy();
    // Host notified of the change.
    expect(onChanged).toHaveBeenCalled();
  });

  it("disconnects a connected provider account", async () => {
    // Google is the connectable provider (microsoft/zoom are "coming soon").
    const initial: CalendarConnection[] = [
      { provider: "google", account: "me@gmail.com", lastSyncAt: null },
    ];
    const { api } = makeApi(initial);
    render(<CalendarSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("calendar-disconnect-google")).toBeTruthy());
    // Never-synced label.
    expect(screen.getByTestId("calendar-account-google-me@gmail.com").textContent).toMatch(
      /Never synced/,
    );

    fireEvent.click(screen.getByTestId("calendar-disconnect-google"));

    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith("google", "me@gmail.com"));
    await waitFor(() => expect(screen.getByTestId("calendar-connect-google")).toBeTruthy());
    expect(screen.queryByTestId("calendar-account-google-me@gmail.com")).toBeNull();
  });

  it("shows Outlook & Zoom as 'Coming soon' (dimmed, no Connect button)", async () => {
    const { api } = makeApi();
    render(<CalendarSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("calendar-connect-google")).toBeTruthy());

    for (const provider of ["microsoft", "zoom"] as const) {
      expect(screen.getByTestId(`calendar-soon-${provider}`).textContent).toMatch(/coming soon/i);
      // No (enabled) Connect/Disconnect affordance for a coming-soon provider.
      expect(screen.queryByTestId(`calendar-connect-${provider}`)).toBeNull();
      expect(screen.queryByTestId(`calendar-disconnect-${provider}`)).toBeNull();
      expect(
        screen.getByTestId(`calendar-provider-${provider}`).getAttribute("data-coming-soon"),
      ).toBe("true");
    }
  });

  it("surfaces a failed/cancelled connect", async () => {
    const { api } = makeApi([], {
      connect: vi.fn(async () => ({ connected: false })),
    });
    render(<CalendarSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("calendar-connect-google")).toBeTruthy());

    fireEvent.click(screen.getByTestId("calendar-connect-google"));
    await waitFor(() =>
      expect(screen.getByTestId("calendar-settings-error").textContent).toMatch(
        /Could not connect Google/i,
      ),
    );
  });

  it("surfaces a connect error instead of throwing", async () => {
    const { api } = makeApi([], {
      connect: vi.fn(async () => {
        throw new Error("oauth window closed");
      }),
    });
    render(<CalendarSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("calendar-connect-google")).toBeTruthy());

    fireEvent.click(screen.getByTestId("calendar-connect-google"));
    await waitFor(() =>
      expect(screen.getByTestId("calendar-settings-error").textContent).toContain(
        "oauth window closed",
      ),
    );
  });

  it("renders without a bridge (no window.loqui) without throwing", () => {
    expect(() => render(<CalendarSettings />)).not.toThrow();
    expect(screen.getByTestId("calendar-provider-google")).toBeTruthy();
  });

  it("READ-ONLY: offers no calendar create/edit/delete affordance", async () => {
    const { api } = makeApi([{ provider: "google", account: "me@example.com", lastSyncAt: null }]);
    render(<CalendarSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("calendar-settings")).toBeTruthy());
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    for (const label of buttons) {
      expect(label).not.toMatch(/create event|new event|edit event|delete event/i);
    }
  });
});
