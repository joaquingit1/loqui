/**
 * DiarizedTranscript render/interaction tests (jsdom). HERMETIC: no
 * window.loqui, no Electron — getDiarizedTranscript/renameSpeaker are injected
 * as controllable fakes.
 *
 * Covers: You / Speaker N lines render with their text + speaker; the roster
 * lists each speaker with an inline rename; renaming calls renameSpeaker and
 * lifts the returned doc so the lines + roster re-label; the degraded
 * (diarization-skipped) note; absent + error states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiarizedTranscript as Doc, RenameSpeakerParams } from "@loqui/shared";
import { DiarizedTranscript } from "./DiarizedTranscript.js";

afterEach(cleanup);

const DOC: Doc = {
  meetingId: "m1",
  version: 1,
  diarized: true,
  backend: "fake",
  speakers: ["Speaker 1", "Speaker 2"],
  segments: [
    { segId: "a", source: "mic", text: "Morning everyone", tStart: 0, tEnd: 2, speaker: "You", displayName: null },
    { segId: "b", source: "system", text: "Hi there", tStart: 2, tEnd: 4, speaker: "Speaker 1", displayName: null },
    { segId: "c", source: "system", text: "Hello", tStart: 4, tEnd: 6, speaker: "Speaker 2", displayName: null },
  ],
};

function makeApi(
  over: Partial<{
    getDiarizedTranscript: () => Promise<Doc | null>;
    renameSpeaker: (p: RenameSpeakerParams) => Promise<Doc>;
  }> = {},
) {
  return {
    getDiarizedTranscript: vi.fn(async () => DOC),
    renameSpeaker: vi.fn(async (p: RenameSpeakerParams) => ({
      ...DOC,
      segments: DOC.segments.map((s) =>
        s.speaker === p.speaker ? { ...s, displayName: p.displayName } : s,
      ),
    })),
    ...over,
  };
}

describe("DiarizedTranscript", () => {
  it("renders You + Speaker N lines with their text", async () => {
    const api = makeApi();
    render(<DiarizedTranscript meetingId="m1" api={api} />);

    await waitFor(() => expect(screen.getAllByTestId("diarized-line").length).toBe(3));
    const lines = screen.getAllByTestId("diarized-line");
    expect(lines[0]!.getAttribute("data-speaker")).toBe("You");
    expect(lines[0]!.textContent).toContain("Morning everyone");
    expect(lines[1]!.getAttribute("data-speaker")).toBe("Speaker 1");
    expect(lines[1]!.textContent).toContain("Hi there");
    expect(lines[2]!.getAttribute("data-speaker")).toBe("Speaker 2");

    // The diarized badge shows ON.
    expect(screen.getByTestId("diarized-badge").getAttribute("data-diarized")).toBe("true");
    expect(api.getDiarizedTranscript).toHaveBeenCalledWith({ meetingId: "m1" });
  });

  it("lists the speaker roster (You + each system speaker)", async () => {
    render(<DiarizedTranscript meetingId="m1" api={makeApi()} />);
    await waitFor(() => expect(screen.getByTestId("diarized-roster")).toBeTruthy());
    expect(screen.getByTestId("diarized-roster-You")).toBeTruthy();
    expect(screen.getByTestId("diarized-roster-Speaker 1")).toBeTruthy();
    expect(screen.getByTestId("diarized-roster-Speaker 2")).toBeTruthy();
  });

  it("renames a speaker: calls renameSpeaker and re-labels the lines", async () => {
    const api = makeApi();
    render(<DiarizedTranscript meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("diarized-roster-Speaker 1")).toBeTruthy());

    // Open the inline rename for Speaker 1.
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 1"));
    const input = screen.getByTestId("speaker-rename-input-Speaker 1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Alex" } });
    fireEvent.click(screen.getByTestId("speaker-rename-save-Speaker 1"));

    await waitFor(() =>
      expect(api.renameSpeaker).toHaveBeenCalledWith({
        meetingId: "m1",
        speaker: "Speaker 1",
        displayName: "Alex",
      }),
    );

    // The returned doc is lifted: the Speaker 1 line now shows "Alex".
    await waitFor(() => {
      const speakerCells = screen.getAllByTestId("diarized-line-speaker").map((s) => s.textContent);
      expect(speakerCells).toContain("Alex");
    });
    // The roster entry for the stable label now shows the rename.
    expect(screen.getByTestId("speaker-name-Speaker 1").textContent).toBe("Alex");
  });

  it("commits a rename on Enter", async () => {
    const api = makeApi();
    render(<DiarizedTranscript meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("speaker-rename-trigger-Speaker 2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 2"));
    fireEvent.change(screen.getByTestId("speaker-rename-input-Speaker 2"), {
      target: { value: "Sam" },
    });
    fireEvent.keyDown(screen.getByTestId("speaker-rename-input-Speaker 2"), { key: "Enter" });
    await waitFor(() =>
      expect(api.renameSpeaker).toHaveBeenCalledWith({
        meetingId: "m1",
        speaker: "Speaker 2",
        displayName: "Sam",
      }),
    );
  });

  it("shows a degraded note when diarization was skipped", async () => {
    const api = makeApi({
      getDiarizedTranscript: vi.fn(async () => ({ ...DOC, diarized: false, backend: "" })),
    });
    render(<DiarizedTranscript meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("diarized-degraded-note")).toBeTruthy());
    expect(screen.getByTestId("diarized-badge").getAttribute("data-diarized")).toBe("false");
  });

  it("shows an absent hint when no diarized transcript exists", async () => {
    const api = makeApi({ getDiarizedTranscript: vi.fn(async () => null) });
    render(<DiarizedTranscript meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("diarized-absent")).toBeTruthy());
  });

  it("surfaces a load error", async () => {
    const api = makeApi({
      getDiarizedTranscript: vi.fn(async () => {
        throw new Error("no file");
      }),
    });
    render(<DiarizedTranscript meetingId="m1" api={api} />);
    await waitFor(() => expect(screen.getByTestId("diarized-error")).toBeTruthy());
    expect(screen.getByTestId("diarized-error").textContent).toContain("no file");
  });
});
