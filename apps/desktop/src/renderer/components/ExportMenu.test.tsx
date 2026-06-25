/**
 * ExportMenu tests (jsdom, hermetic): selecting a format calls the export bridge
 * and surfaces the written path; an error is shown on failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportMenu } from "./ExportMenu.js";

afterEach(cleanup);

describe("ExportMenu", () => {
  it("exports the chosen format and shows the written path", async () => {
    const exportMeeting = vi.fn(async ({ format }: { format: string }) => ({
      meetingId: "m1",
      format,
      path: `C:/exports/roadmap.${format}`,
      bytes: 1234,
      usedDiarized: true,
    }));
    render(<ExportMenu meetingId="m1" api={{ exportMeeting } as never} />);

    fireEvent.click(screen.getByTestId("export-srt"));
    await waitFor(() => {
      expect(screen.getByTestId("export-result").textContent).toContain("roadmap.srt");
    });
    expect(exportMeeting).toHaveBeenCalledWith({ meetingId: "m1", format: "srt" });
  });

  it("offers all seven formats", () => {
    render(<ExportMenu meetingId="m1" api={{ exportMeeting: vi.fn() } as never} />);
    for (const f of ["md", "obsidian", "srt", "vtt", "json", "pdf", "docx"]) {
      expect(screen.getByTestId(`export-${f}`)).toBeTruthy();
    }
  });

  it("shows an error when the export fails", async () => {
    const exportMeeting = vi.fn(async () => {
      throw new Error("disk full");
    });
    render(<ExportMenu meetingId="m1" api={{ exportMeeting } as never} />);
    fireEvent.click(screen.getByTestId("export-pdf"));
    await waitFor(() => {
      expect(screen.getByTestId("export-error").textContent).toContain("disk full");
    });
  });
});
