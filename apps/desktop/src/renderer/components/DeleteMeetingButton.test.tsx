/**
 * DeleteMeetingButton tests (jsdom). HERMETIC: the deleteMeeting bridge is an
 * injected fake. Covers the two-step confirm (first click arms, second click
 * deletes), the ~2.5s auto-revert, the success → onDeleted lift, the error path,
 * and that the icon variant stops propagation (so a Library row doesn't open).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeleteMeetingButton } from "./DeleteMeetingButton.js";

afterEach(cleanup);

const ID = "11111111-1111-4111-8111-111111111111";

describe("DeleteMeetingButton", () => {
  it("requires a two-step confirm: first click arms, second deletes + fires onDeleted", async () => {
    const deleteMeeting = vi.fn(async () => {});
    const onDeleted = vi.fn();
    render(
      <DeleteMeetingButton meetingId={ID} api={{ deleteMeeting }} onDeleted={onDeleted} />,
    );

    const btn = screen.getByTestId("meeting-delete");
    expect(btn.textContent).toContain("Delete");
    expect(btn.getAttribute("data-phase")).toBe("idle");

    // First click ARMS (does not delete yet).
    fireEvent.click(btn);
    expect(btn.getAttribute("data-phase")).toBe("confirming");
    expect(btn.textContent).toContain("Confirm");
    expect(deleteMeeting).not.toHaveBeenCalled();

    // Second click deletes.
    fireEvent.click(btn);
    await waitFor(() => expect(deleteMeeting).toHaveBeenCalledWith({ id: ID }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(ID));
  });

  it("auto-reverts the confirm after the timeout (no accidental delete)", () => {
    vi.useFakeTimers();
    try {
      const deleteMeeting = vi.fn(async () => {});
      render(<DeleteMeetingButton meetingId={ID} api={{ deleteMeeting }} />);
      const btn = screen.getByTestId("meeting-delete");
      fireEvent.click(btn);
      expect(btn.getAttribute("data-phase")).toBe("confirming");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(btn.getAttribute("data-phase")).toBe("idle");
      expect(deleteMeeting).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a delete failure and reverts to idle (no onDeleted)", async () => {
    const deleteMeeting = vi.fn(async () => {
      throw new Error("index locked");
    });
    const onDeleted = vi.fn();
    render(
      <DeleteMeetingButton meetingId={ID} api={{ deleteMeeting }} onDeleted={onDeleted} />,
    );
    const btn = screen.getByTestId("meeting-delete");
    fireEvent.click(btn); // arm
    fireEvent.click(btn); // delete (fails)
    await waitFor(() => expect(btn.getAttribute("data-phase")).toBe("idle"));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(btn.getAttribute("title")).toContain("index locked");
  });

  it("icon variant stops propagation so it never opens a clickable row", () => {
    const deleteMeeting = vi.fn(async () => {});
    const onRowClick = vi.fn();
    render(
      <button type="button" onClick={onRowClick}>
        <span>row</span>
        {/* the delete sits as a sibling in real markup, but stopPropagation is
            the guard that matters; assert it doesn't bubble. */}
      </button>,
    );
    cleanup();
    render(
      <div onClick={onRowClick}>
        <DeleteMeetingButton variant="icon" meetingId={ID} api={{ deleteMeeting }} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("meeting-delete"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
