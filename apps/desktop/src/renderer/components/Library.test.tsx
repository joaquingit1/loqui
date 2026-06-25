/**
 * Library render/interaction tests (jsdom). HERMETIC: no window.loqui, no
 * Electron, no sidecar — the LoquiLibraryApi is injected as a controllable
 * fake. Covers: grouped-by-date list, empty state, full-text search (calls
 * searchMeetings + renders snippets), date-range filter (re-lists with bounds),
 * and opening a meeting (renders its transcript via MeetingView).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Meeting, MeetingSearchHit } from "@loqui/shared";
import { Library } from "./Library.js";
import type { LoquiLibraryApi } from "../../preload/index.js";

afterEach(cleanup);

// Reference "now": Wednesday 2026-06-24 15:00 local.
const NOW = new Date("2026-06-24T15:00:00");

function meeting(overrides: Partial<Meeting> & { id: string; createdAt: string }): Meeting {
  return {
    title: "",
    platform: null,
    startedAt: null,
    endedAt: null,
    status: "done",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

const TODAY = meeting({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Daily standup",
  platform: "google-meet",
  startedAt: "2026-06-24T14:00:00Z",
  endedAt: "2026-06-24T14:18:30Z",
  createdAt: "2026-06-24T14:00:00",
});
const YESTERDAY = meeting({
  id: "22222222-2222-4222-8222-222222222222",
  title: "Design review",
  platform: "zoom",
  createdAt: "2026-06-23T10:00:00",
});

function makeApi(overrides: Partial<LoquiLibraryApi> = {}): LoquiLibraryApi {
  return {
    startMeeting: vi.fn(async () => TODAY),
    stopMeeting: vi.fn(async () => TODAY),
    listMeetings: vi.fn(async () => [TODAY, YESTERDAY]),
    searchMeetings: vi.fn(async () => []),
    getTranscript: vi.fn(async () => ""),
    renameMeeting: vi.fn(async () => TODAY),
    importFile: vi.fn(async () => TODAY),
    pickAndImportFile: vi.fn(async () => TODAY),
    onMeetingStatus: () => () => {},
    ...overrides,
  };
}

describe("Library", () => {
  it("lists meetings grouped by date with title, duration, platform, status", async () => {
    const api = makeApi();
    render(<Library api={api} now={NOW} />);

    await waitFor(() => expect(screen.getByTestId("library-group-today")).toBeTruthy());
    expect(screen.getByTestId("library-group-yesterday")).toBeTruthy();

    const todayGroup = screen.getByTestId("library-group-today");
    expect(todayGroup.textContent).toContain("Daily standup");
    expect(todayGroup.textContent).toContain("Google Meet");
    expect(todayGroup.textContent).toContain("Done");
    // 14:18:30 - 14:00:00 = 18m30s.
    expect(todayGroup.textContent).toContain("18:30");

    expect(api.listMeetings).toHaveBeenCalled();
  });

  it("renders an empty state when there are no meetings", async () => {
    const api = makeApi({ listMeetings: vi.fn(async () => []) });
    render(<Library api={api} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("library-empty")).toBeTruthy());
    expect(screen.queryByTestId("library-group-today")).toBeNull();
  });

  it("searches via searchMeetings and renders hits with snippets", async () => {
    const hits: MeetingSearchHit[] = [
      { meeting: YESTERDAY, snippet: "we discussed the <b>roadmap</b> for Q3" },
    ];
    const searchMeetings = vi.fn(async () => hits);
    const api = makeApi({ searchMeetings });
    render(<Library api={api} now={NOW} />);

    await waitFor(() => expect(screen.getByTestId("library-group-today")).toBeTruthy());

    fireEvent.change(screen.getByTestId("library-search"), { target: { value: "roadmap" } });

    await waitFor(() => expect(screen.getByTestId("library-search-results")).toBeTruthy());
    expect(searchMeetings).toHaveBeenCalledWith("roadmap");
    const snippet = screen.getByTestId(`library-snippet-${YESTERDAY.id}`);
    expect(snippet.textContent).toContain("roadmap");
    // The grouped list is hidden while searching.
    expect(screen.queryByTestId("library-group-today")).toBeNull();
  });

  it("shows a no-matches state when search returns nothing", async () => {
    const api = makeApi({ searchMeetings: vi.fn(async () => []) });
    render(<Library api={api} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("library-group-today")).toBeTruthy());

    fireEvent.change(screen.getByTestId("library-search"), { target: { value: "nope" } });
    await waitFor(() => expect(screen.getByTestId("library-search-empty")).toBeTruthy());
  });

  it("clearing the search box returns to the grouped list", async () => {
    const api = makeApi({
      searchMeetings: vi.fn(async () => [{ meeting: TODAY, snippet: "hi" }]),
    });
    render(<Library api={api} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("library-group-today")).toBeTruthy());

    const box = screen.getByTestId("library-search");
    fireEvent.change(box, { target: { value: "hi" } });
    await waitFor(() => expect(screen.getByTestId("library-search-results")).toBeTruthy());

    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("library-group-today")).toBeTruthy());
    expect(screen.queryByTestId("library-search-results")).toBeNull();
  });

  it("re-lists with ISO date bounds when the date filter changes", async () => {
    const listMeetings: LoquiLibraryApi["listMeetings"] = vi.fn(async () => [TODAY, YESTERDAY]);
    const api = makeApi({ listMeetings });
    render(<Library api={api} now={NOW} />);
    await waitFor(() => expect(listMeetings).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("library-from"), { target: { value: "2026-06-23" } });

    await waitFor(() => {
      const calls = vi.mocked(listMeetings).mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last?.from).toBeTruthy();
      expect(last?.from).toContain("2026-06-23");
    });
  });

  it("opens a meeting and renders its transcript via the getTranscript bridge", async () => {
    const getTranscript = vi.fn(async () => "[00:00:04] You said: Hello there\n");
    const api = makeApi({ getTranscript });
    render(<Library api={api} now={NOW} />);

    await waitFor(() => expect(screen.getByTestId(`library-row-${TODAY.id}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`library-row-${TODAY.id}`));

    await waitFor(() => expect(screen.getByTestId("meeting-view")).toBeTruthy());
    expect(getTranscript).toHaveBeenCalledWith({ id: TODAY.id, variant: "live" });
    await waitFor(() =>
      expect(screen.getByTestId("meeting-transcript-text").textContent).toContain(
        "You said: Hello there",
      ),
    );

    // Back returns to the list.
    fireEvent.click(screen.getByTestId("meeting-back"));
    await waitFor(() => expect(screen.getByTestId("library-group-today")).toBeTruthy());
  });

  it("surfaces a list error instead of throwing", async () => {
    const api = makeApi({
      listMeetings: vi.fn(async () => {
        throw new Error("disk gone");
      }),
    });
    render(<Library api={api} now={NOW} />);
    await waitFor(() => expect(screen.getByTestId("library-error")).toBeTruthy());
    expect(screen.getByTestId("library-error").textContent).toContain("disk gone");
  });
});
