/**
 * LiveTranscript render/interaction tests (jsdom). HERMETIC: no window.loqui,
 * no Electron, no sidecar — the onTranscriptSegment bridge is injected as a
 * controllable fake. The view is the editorial FLOWING stream (DESIGN-SYSTEM
 * §9.10): one time-ordered column of lines (timestamp + speaker + text), not
 * two side-by-side chat columns. Covers: empty state, partial render, partial-
 * replace in place, final-commit, two-source (You/They) attribution + ordering,
 * meeting filter, unsubscribe, and the auto-scroll pause-on-scroll-up +
 * jump-to-live affordance.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TranscriptSegment } from "@loqui/shared";
import { LiveTranscript } from "./LiveTranscript.js";
import type { LoquiApi } from "../../preload/index.js";

afterEach(cleanup);

const MEETING = "33333333-3333-4333-8333-333333333333";

/** A fake transcript bridge we can push segments through synchronously. */
function makeFakeBridge(): {
  api: Pick<LoquiApi, "onTranscriptSegment">;
  emit: (seg: Partial<TranscriptSegment>) => void;
  subscribers: () => number;
} {
  const listeners = new Set<(s: TranscriptSegment) => void>();
  const api: Pick<LoquiApi, "onTranscriptSegment"> = {
    onTranscriptSegment: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  const emit = (overrides: Partial<TranscriptSegment>): void => {
    const seg: TranscriptSegment = {
      meetingId: MEETING,
      source: "mic",
      text: "",
      tStart: 0,
      tEnd: 0,
      status: "partial",
      segId: "s1",
      ...overrides,
    };
    act(() => {
      for (const cb of [...listeners]) cb(seg);
    });
  };
  return { api, emit, subscribers: () => listeners.size };
}

describe("LiveTranscript", () => {
  it("renders an empty/listening hint with no lines", () => {
    const { api } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    expect(screen.getByTestId("live-transcript")).toBeTruthy();
    expect(screen.getByTestId("transcript-flow")).toBeTruthy();
    expect(screen.getByTestId("transcript-empty")).toBeTruthy();
  });

  it("renders an incoming partial segment as dimmed (partial status)", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    emit({ source: "mic", segId: "a", text: "hello", status: "partial" });
    const line = screen.getByTestId("segment-mic-a");
    expect(line.textContent).toContain("hello");
    expect(line.getAttribute("data-status")).toBe("partial");
    expect(screen.queryByTestId("transcript-empty")).toBeNull();
  });

  it("replaces a partial in place as text grows (same segId, one node)", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    emit({ source: "mic", segId: "a", text: "he", status: "partial" });
    emit({ source: "mic", segId: "a", text: "hello", status: "partial" });
    const lines = screen.getAllByTestId(/^segment-mic-/);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toContain("hello");
  });

  it("commits a partial to final in place (status flips to final)", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    emit({ source: "mic", segId: "a", text: "hello", status: "partial" });
    expect(screen.getByTestId("segment-mic-a").getAttribute("data-status")).toBe(
      "partial",
    );
    emit({ source: "mic", segId: "a", text: "hello world", status: "final" });
    const line = screen.getByTestId("segment-mic-a");
    expect(line.getAttribute("data-status")).toBe("final");
    expect(line.textContent).toContain("hello world");
    expect(screen.getAllByTestId(/^segment-mic-/)).toHaveLength(1);
  });

  it("attributes You (mic) and They (system) lines distinctly and orders by time", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    emit({ source: "system", segId: "x", text: "they said", status: "final", tStart: 2 });
    emit({ source: "mic", segId: "y", text: "you said", status: "final", tStart: 8 });

    const you = screen.getByTestId("segment-mic-y");
    const they = screen.getByTestId("segment-system-x");
    expect(you.getAttribute("data-source")).toBe("mic");
    expect(they.getAttribute("data-source")).toBe("system");
    expect(you.textContent).toContain("you said");
    expect(they.textContent).toContain("they said");

    // The merged flow is ordered by media time: They (t=2) precedes You (t=8).
    const flow = screen.getByTestId("transcript-flow");
    const order = [...flow.querySelectorAll("[data-seg-id]")].map((n) =>
      n.getAttribute("data-seg-id"),
    );
    expect(order).toEqual(["x", "y"]);
  });

  it("ignores segments from other meetings when a meetingId filter is set", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} meetingId={MEETING} />);
    emit({ source: "mic", segId: "keep", text: "mine", meetingId: MEETING });
    emit({
      source: "mic",
      segId: "drop",
      text: "stale",
      meetingId: "99999999-9999-4999-8999-999999999999",
    });
    expect(screen.getByTestId("segment-mic-keep")).toBeTruthy();
    expect(screen.queryByTestId("segment-mic-drop")).toBeNull();
  });

  it("unsubscribes from the bridge on unmount", () => {
    const { api, emit, subscribers } = makeFakeBridge();
    const { unmount } = render(<LiveTranscript api={api} />);
    expect(subscribers()).toBe(1);
    unmount();
    expect(subscribers()).toBe(0);
    // Emitting after unmount must not throw.
    expect(() => emit({ segId: "a" })).not.toThrow();
  });

  it("pauses auto-scroll when the user scrolls up and shows Jump-to-live, which resumes", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    // A line so the flow has content (jump only shows with lines present).
    emit({ source: "mic", segId: "seed", text: "first", status: "final" });
    const flow = screen.getByTestId("transcript-flow");

    // jsdom doesn't lay out, so fake the scroll geometry: a tall, scrolled-up box.
    Object.defineProperty(flow, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(flow, "clientHeight", { value: 200, configurable: true });
    flow.scrollTop = 0; // scrolled to the top => not at bottom

    fireEvent.scroll(flow);
    expect(screen.getByTestId("transcript-jump")).toBeTruthy();

    // New content arrives while paused — auto-scroll must NOT yank to bottom.
    emit({ source: "mic", segId: "a", text: "stay put", status: "partial" });
    expect(flow.scrollTop).toBe(0);

    // Jump-to-live resumes sticking and pins to the bottom.
    fireEvent.click(screen.getByTestId("transcript-jump"));
    expect(flow.scrollTop).toBe(flow.scrollHeight);
    expect(screen.queryByTestId("transcript-jump")).toBeNull();
  });
});
