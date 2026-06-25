/**
 * MeetingView render/interaction tests (jsdom). HERMETIC: no window.loqui, no
 * Electron — getTranscript/renameMeeting are injected as controllable fakes.
 * Covers: transcript render, empty + error transcript states, inline rename
 * (calls renameMeeting, lifts the updated Meeting, updates the title), rename
 * cancel/Escape, and read-only-ness (no transcript write surface is used).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Meeting } from "@loqui/shared";
import { MeetingView } from "./MeetingView.js";
import type { LoquiLibraryApi } from "../../preload/index.js";

afterEach(cleanup);

const MEETING: Meeting = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Sprint planning",
  platform: "teams",
  startedAt: "2026-06-24T14:00:00Z",
  endedAt: "2026-06-24T14:30:00Z",
  status: "done",
  kind: "meeting",
  participants: [],
  modelVersions: {},
  createdAt: "2026-06-24T14:00:00",
  updatedAt: "2026-06-24T14:30:00",
};

type Api = Pick<LoquiLibraryApi, "getTranscript" | "renameMeeting">;

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    getTranscript: vi.fn(async () => "[00:00:01] You said: Hi\n[00:00:03] They said: Hello\n"),
    renameMeeting: vi.fn(async (params) => ({ ...MEETING, title: params.title })),
    ...overrides,
  };
}

describe("MeetingView", () => {
  it("loads and renders the transcript and meeting meta", async () => {
    const api = makeApi();
    render(<MeetingView meeting={MEETING} api={api} />);

    await waitFor(() => expect(screen.getByTestId("meeting-transcript-text")).toBeTruthy());
    const text = screen.getByTestId("meeting-transcript-text").textContent ?? "";
    expect(text).toContain("You said: Hi");
    expect(text).toContain("They said: Hello");

    expect(api.getTranscript).toHaveBeenCalledWith({ id: MEETING.id, variant: "live" });
    // Meta collapses to one muted line: platform · duration (no "STATUS Done").
    const meta = screen.getByTestId("meeting-meta");
    expect(meta.textContent).toContain("Teams");
    expect(meta.textContent).toContain("30:00"); // duration
    expect(meta.textContent).not.toContain("Done"); // status surfaces by exception, not as a stat
    expect(screen.getByTestId("meeting-title").textContent).toContain("Sprint planning");
  });

  it("shows an empty-transcript hint when the file is empty", async () => {
    const api = makeApi({ getTranscript: vi.fn(async () => "") });
    render(<MeetingView meeting={MEETING} api={api} />);
    await waitFor(() => expect(screen.getByTestId("meeting-transcript-empty")).toBeTruthy());
    expect(screen.queryByTestId("meeting-transcript-text")).toBeNull();
  });

  it("surfaces a transcript load error", async () => {
    const api = makeApi({
      getTranscript: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    render(<MeetingView meeting={MEETING} api={api} />);
    await waitFor(() => expect(screen.getByTestId("meeting-transcript-error")).toBeTruthy());
    expect(screen.getByTestId("meeting-transcript-error").textContent).toContain("read failed");
  });

  it("renames inline: calls renameMeeting, lifts the updated meeting, updates the title", async () => {
    const renameMeeting = vi.fn(async (params: { id: string; title: string }) => ({
      ...MEETING,
      title: params.title,
    }));
    const onRenamed = vi.fn();
    const api = makeApi({ renameMeeting });
    render(<MeetingView meeting={MEETING} api={api} onRenamed={onRenamed} />);

    fireEvent.click(screen.getByTestId("meeting-rename-trigger"));
    const input = screen.getByTestId("meeting-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Sprint planning");

    fireEvent.change(input, { target: { value: "Q3 kickoff" } });
    fireEvent.click(screen.getByTestId("meeting-rename-save"));

    await waitFor(() =>
      expect(renameMeeting).toHaveBeenCalledWith({ id: MEETING.id, title: "Q3 kickoff" }),
    );
    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));
    expect(onRenamed.mock.calls[0]![0]).toMatchObject({ id: MEETING.id, title: "Q3 kickoff" });
    // The editor closes back to the title view.
    await waitFor(() => expect(screen.queryByTestId("meeting-rename-input")).toBeNull());
  });

  it("commits a rename on Enter and cancels on Escape", async () => {
    const renameMeeting = vi.fn(async (params: { id: string; title: string }) => ({
      ...MEETING,
      title: params.title,
    }));
    const api = makeApi({ renameMeeting });
    render(<MeetingView meeting={MEETING} api={api} />);

    // Enter commits.
    fireEvent.click(screen.getByTestId("meeting-rename-trigger"));
    fireEvent.change(screen.getByTestId("meeting-rename-input"), {
      target: { value: "Renamed via enter" },
    });
    fireEvent.keyDown(screen.getByTestId("meeting-rename-input"), { key: "Enter" });
    await waitFor(() =>
      expect(renameMeeting).toHaveBeenCalledWith({ id: MEETING.id, title: "Renamed via enter" }),
    );

    // Escape cancels (no second call).
    fireEvent.click(screen.getByTestId("meeting-rename-trigger"));
    fireEvent.change(screen.getByTestId("meeting-rename-input"), {
      target: { value: "discarded" },
    });
    fireEvent.keyDown(screen.getByTestId("meeting-rename-input"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("meeting-rename-input")).toBeNull());
    expect(renameMeeting).toHaveBeenCalledTimes(1);
  });

  it("does not call renameMeeting when the title is unchanged", async () => {
    const api = makeApi();
    render(<MeetingView meeting={MEETING} api={api} />);
    fireEvent.click(screen.getByTestId("meeting-rename-trigger"));
    fireEvent.click(screen.getByTestId("meeting-rename-save"));
    await waitFor(() => expect(screen.queryByTestId("meeting-rename-input")).toBeNull());
    expect(api.renameMeeting).not.toHaveBeenCalled();
  });

  it("surfaces a rename failure and keeps the editor open", async () => {
    const api = makeApi({
      renameMeeting: vi.fn(async () => {
        throw new Error("index locked");
      }),
    });
    render(<MeetingView meeting={MEETING} api={api} />);
    fireEvent.click(screen.getByTestId("meeting-rename-trigger"));
    fireEvent.change(screen.getByTestId("meeting-rename-input"), { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("meeting-rename-save"));

    await waitFor(() => expect(screen.getByTestId("meeting-rename-error")).toBeTruthy());
    expect(screen.getByTestId("meeting-rename-error").textContent).toContain("index locked");
    expect(screen.getByTestId("meeting-rename-input")).toBeTruthy();
  });

  it("renders the read-only chat panel below the summary (PRD-16 chat-below)", async () => {
    const api = makeApi();
    render(<MeetingView meeting={MEETING} api={api} />);

    // A "done" meeting shows the summary, and the ask-about-this-meeting chat
    // surface sits below it (grounded in the transcript, read-only).
    await waitFor(() => expect(screen.getByTestId("summary-view")).toBeTruthy());
    const chat = screen.getByTestId("meeting-chat");
    expect(chat).toBeTruthy();
    expect(screen.getByTestId("chat-panel")).toBeTruthy();
    // The AI-never-edits-the-transcript guarantee is structural (the bridge has
    // no transcript writer), not user-facing chrome — so no nagging note.
    expect(screen.queryByTestId("chat-readonly-note")).toBeNull();
  });

  it("fires onBack when the back button is clicked", async () => {
    const onBack = vi.fn();
    render(<MeetingView meeting={MEETING} api={makeApi()} onBack={onBack} />);
    // Let the async transcript load settle so no state update escapes act().
    await waitFor(() => expect(screen.getByTestId("meeting-transcript-text")).toBeTruthy());
    fireEvent.click(screen.getByTestId("meeting-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
