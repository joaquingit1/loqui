/**
 * SummaryView render/interaction tests (jsdom). HERMETIC: no window.loqui, no
 * Electron — getSummary/regenerateSummary are injected as controllable fakes.
 *
 * Covers: the four sections render (TL;DR, decisions, action items + owners,
 * topics), absent + error + empty states, and the Regenerate button calls the
 * bridge + fires onRegenerate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Summary } from "@loqui/shared";
import { SummaryView } from "./SummaryView.js";

afterEach(cleanup);

const SUMMARY: Summary = {
  meetingId: "m1",
  version: 1,
  tldr: "We agreed to ship the beta on Friday.",
  decisions: ["Ship the beta Friday", "Freeze scope today"],
  actionItems: [
    { text: "Write the release notes", owner: "Alex" },
    { text: "Set up the staging env", owner: null },
  ],
  topics: ["Release timeline", "Scope"],
  provider: "anthropic",
  model: "claude-opus-4-8",
  generatedAt: "2026-06-23T10:00:00Z",
};

function makeApi(over: Partial<{ getSummary: () => Promise<Summary | null>; regenerateSummary: () => Promise<void> }> = {}) {
  return {
    getSummary: vi.fn(async () => SUMMARY),
    regenerateSummary: vi.fn(async () => {}),
    ...over,
  };
}

describe("SummaryView", () => {
  it("renders TL;DR, decisions, action items (with owners), and topics", async () => {
    const api = makeApi();
    render(<SummaryView meetingId="m1" api={api} />);

    await waitFor(() => expect(screen.getByTestId("summary-tldr")).toBeTruthy());
    expect(screen.getByTestId("summary-tldr").textContent).toContain("ship the beta");

    const decisions = screen.getAllByTestId("summary-decision");
    expect(decisions.map((d) => d.textContent)).toEqual([
      "Ship the beta Friday",
      "Freeze scope today",
    ]);

    const actions = screen.getAllByTestId("summary-action-item");
    expect(actions.length).toBe(2);
    expect(actions[0]!.textContent).toContain("Write the release notes");
    expect(actions[0]!.textContent).toContain("Alex");
    // The owner-less action has no owner chip.
    expect(screen.getAllByTestId("summary-action-owner").length).toBe(1);

    const topics = screen.getAllByTestId("summary-topic");
    expect(topics.map((t) => t.textContent)).toEqual(["Release timeline", "Scope"]);

    expect(screen.getByTestId("summary-provider").textContent).toContain("anthropic");
    expect(api.getSummary).toHaveBeenCalledWith({ meetingId: "m1" });
  });

  it("shows an absent hint when no summary exists yet", async () => {
    const api = makeApi({ getSummary: vi.fn(async () => null) });
    render(<SummaryView meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("summary-absent")).toBeTruthy());
    expect(screen.queryByTestId("summary-tldr")).toBeNull();
  });

  it("renders the streamed summary text live while it generates (no summary yet)", async () => {
    const api = makeApi({ getSummary: vi.fn(async () => null) });
    render(
      <SummaryView meetingId="m1" api={api} streamingText="The team agreed to ship" />,
    );
    // While generating (no parsed summary.json yet), the live stream replaces the
    // absent hint as the preview.
    await waitFor(() => expect(screen.getByTestId("summary-streaming")).toBeTruthy());
    expect(screen.getByTestId("summary-streaming").textContent).toContain(
      "The team agreed to ship",
    );
    expect(screen.queryByTestId("summary-absent")).toBeNull();
  });

  it("prefers the parsed summary over the stream once it has loaded", async () => {
    const api = makeApi(); // returns the full SUMMARY
    render(<SummaryView meetingId="m1" api={api} streamingText="partial stream…" />);
    await waitFor(() => expect(screen.getByTestId("summary-tldr")).toBeTruthy());
    // The structured sections win; the streaming preview is gone.
    expect(screen.queryByTestId("summary-streaming")).toBeNull();
  });

  it("surfaces a load error", async () => {
    const api = makeApi({
      getSummary: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    render(<SummaryView meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("summary-error")).toBeTruthy());
    expect(screen.getByTestId("summary-error").textContent).toContain("read failed");
  });

  it("Regenerate calls the bridge and fires onRegenerate", async () => {
    const api = makeApi();
    const onRegenerate = vi.fn();
    render(<SummaryView meetingId="m1" api={api} onRegenerate={onRegenerate} />);
    await waitFor(() => expect(screen.getByTestId("summary-tldr")).toBeTruthy());

    fireEvent.click(screen.getByTestId("summary-regenerate"));
    expect(api.regenerateSummary).toHaveBeenCalledWith({ meetingId: "m1" });
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("reflects an in-flight regenerate in the button label + disables it", async () => {
    const api = makeApi();
    render(<SummaryView meetingId="m1" api={api} regenerating />);
    await waitFor(() => expect(screen.getByTestId("summary-tldr")).toBeTruthy());
    const btn = screen.getByTestId("summary-regenerate") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Regenerating…");
  });

  it("refetches when reloadKey changes", async () => {
    const api = makeApi();
    const { rerender } = render(<SummaryView meetingId="m1" api={api} reloadKey={0} />);
    await waitFor(() => expect(api.getSummary).toHaveBeenCalledTimes(1));
    rerender(<SummaryView meetingId="m1" api={api} reloadKey={1} />);
    await waitFor(() => expect(api.getSummary).toHaveBeenCalledTimes(2));
  });
});
