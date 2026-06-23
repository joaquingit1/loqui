/**
 * LiveTranscript render/interaction tests (jsdom). HERMETIC: no window.loqui,
 * no Electron, no sidecar — the onTranscriptSegment bridge is injected as a
 * controllable fake. Covers: empty state, partial render, partial-replace in
 * place, final-commit, two-stream (You/They) separation, meeting filter, and
 * the auto-scroll pause-on-scroll-up + jump-to-live affordance.
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
  it("renders both stream headers (You / They) and an empty hint", () => {
    const { api } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    expect(screen.getByTestId("live-transcript")).toBeTruthy();
    expect(screen.getByTestId("transcript-stream-mic")).toBeTruthy();
    expect(screen.getByTestId("transcript-stream-system")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("They")).toBeTruthy();
    expect(screen.getByTestId("transcript-empty")).toBeTruthy();
  });

  it("renders an incoming partial segment as dimmed (partial status)", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    emit({ source: "mic", segId: "a", text: "hello", status: "partial" });
    const line = screen.getByTestId("segment-mic-a");
    expect(line.textContent).toBe("hello");
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
    expect(lines[0]!.textContent).toBe("hello");
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
    expect(line.textContent).toBe("hello world");
    expect(screen.getAllByTestId(/^segment-mic-/)).toHaveLength(1);
  });

  it("keeps You (mic) and They (system) separate — same segId, two streams", () => {
    const { api, emit } = makeFakeBridge();
    render(<LiveTranscript api={api} />);
    emit({ source: "mic", segId: "x", text: "you said", status: "final" });
    emit({ source: "system", segId: "x", text: "they said", status: "final" });

    const micLines = screen.getByTestId("transcript-lines-mic");
    const sysLines = screen.getByTestId("transcript-lines-system");
    expect(micLines.textContent).toContain("you said");
    expect(micLines.textContent).not.toContain("they said");
    expect(sysLines.textContent).toContain("they said");
    expect(sysLines.textContent).not.toContain("you said");
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
    const lines = screen.getByTestId("transcript-lines-mic");

    // jsdom doesn't lay out, so fake the scroll geometry: a tall, scrolled-up box.
    Object.defineProperty(lines, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(lines, "clientHeight", { value: 200, configurable: true });
    lines.scrollTop = 0; // scrolled to the top => not at bottom

    fireEvent.scroll(lines);
    expect(screen.getByTestId("transcript-jump-mic")).toBeTruthy();

    // New content arrives while paused — auto-scroll must NOT yank to bottom.
    emit({ source: "mic", segId: "a", text: "stay put", status: "partial" });
    expect(lines.scrollTop).toBe(0);

    // Jump-to-live resumes sticking and pins to the bottom.
    fireEvent.click(screen.getByTestId("transcript-jump-mic"));
    expect(lines.scrollTop).toBe(lines.scrollHeight);
    expect(screen.queryByTestId("transcript-jump-mic")).toBeNull();
  });
});
