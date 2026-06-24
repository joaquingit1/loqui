/**
 * SpeakerRename render/interaction tests (jsdom). HERMETIC: onRename is a
 * controllable fake. Covers: shows the label (or rename), opens an editor,
 * Save calls onRename with the trimmed name, Enter commits, Escape cancels,
 * empty input clears (empty displayName), no-op when unchanged, error surfaced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SpeakerRename } from "./SpeakerRename.js";

afterEach(cleanup);

describe("SpeakerRename", () => {
  it("shows the stable label when not renamed and the rename when present", () => {
    const { rerender } = render(
      <SpeakerRename label="Speaker 1" displayName={null} onRename={vi.fn(async () => {})} />,
    );
    expect(screen.getByTestId("speaker-name-Speaker 1").textContent).toBe("Speaker 1");
    rerender(<SpeakerRename label="Speaker 1" displayName="Alex" onRename={vi.fn(async () => {})} />);
    expect(screen.getByTestId("speaker-name-Speaker 1").textContent).toBe("Alex");
  });

  it("Save calls onRename with the trimmed new name", async () => {
    const onRename = vi.fn(async () => {});
    render(<SpeakerRename label="Speaker 1" displayName={null} onRename={onRename} />);
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 1"));
    fireEvent.change(screen.getByTestId("speaker-rename-input-Speaker 1"), {
      target: { value: "  Alex  " },
    });
    fireEvent.click(screen.getByTestId("speaker-rename-save-Speaker 1"));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Speaker 1", "Alex"));
  });

  it("Escape cancels without calling onRename", async () => {
    const onRename = vi.fn(async () => {});
    render(<SpeakerRename label="Speaker 1" displayName={null} onRename={onRename} />);
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 1"));
    fireEvent.change(screen.getByTestId("speaker-rename-input-Speaker 1"), {
      target: { value: "X" },
    });
    fireEvent.keyDown(screen.getByTestId("speaker-rename-input-Speaker 1"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("speaker-rename-input-Speaker 1")).toBeNull(),
    );
    expect(onRename).not.toHaveBeenCalled();
  });

  it("clearing the input to empty submits an empty displayName (clear the rename)", async () => {
    const onRename = vi.fn(async () => {});
    render(<SpeakerRename label="Speaker 1" displayName="Alex" onRename={onRename} />);
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 1"));
    fireEvent.change(screen.getByTestId("speaker-rename-input-Speaker 1"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("speaker-rename-save-Speaker 1"));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Speaker 1", ""));
  });

  it("is a no-op when the name is unchanged", async () => {
    const onRename = vi.fn(async () => {});
    render(<SpeakerRename label="Speaker 1" displayName="Alex" onRename={onRename} />);
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 1"));
    // The editor pre-fills with "Alex"; save immediately.
    fireEvent.click(screen.getByTestId("speaker-rename-save-Speaker 1"));
    await waitFor(() =>
      expect(screen.queryByTestId("speaker-rename-input-Speaker 1")).toBeNull(),
    );
    expect(onRename).not.toHaveBeenCalled();
  });

  it("surfaces an error and keeps the editor open", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("index locked");
    });
    render(<SpeakerRename label="Speaker 1" displayName={null} onRename={onRename} />);
    fireEvent.click(screen.getByTestId("speaker-rename-trigger-Speaker 1"));
    fireEvent.change(screen.getByTestId("speaker-rename-input-Speaker 1"), {
      target: { value: "Alex" },
    });
    fireEvent.click(screen.getByTestId("speaker-rename-save-Speaker 1"));
    await waitFor(() => expect(screen.getByTestId("speaker-rename-error-Speaker 1")).toBeTruthy());
    expect(screen.getByTestId("speaker-rename-error-Speaker 1").textContent).toContain(
      "index locked",
    );
    expect(screen.getByTestId("speaker-rename-input-Speaker 1")).toBeTruthy();
  });

  it("disables the trigger when disabled", () => {
    render(
      <SpeakerRename label="You" displayName={null} onRename={vi.fn(async () => {})} disabled />,
    );
    expect((screen.getByTestId("speaker-rename-trigger-You") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
