/**
 * RecordingStatus render tests (jsdom). Pure presentation — props in, DOM out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecordingStatus } from "./RecordingStatus.js";

afterEach(cleanup);

describe("RecordingStatus", () => {
  it("renders the idle pill with no clock", () => {
    render(<RecordingStatus phase="idle" elapsedSeconds={0} />);
    const status = screen.getByTestId("recording-status");
    expect(status.getAttribute("data-phase")).toBe("idle");
    expect(screen.getByTestId("recording-status-pill").textContent).toContain(
      "Not recording",
    );
    expect(screen.queryByTestId("recording-elapsed")).toBeNull();
  });

  it("shows a live clock while recording", () => {
    render(<RecordingStatus phase="recording" elapsedSeconds={65} />);
    expect(screen.getByTestId("recording-status-pill").textContent).toContain(
      "Recording",
    );
    expect(screen.getByTestId("recording-elapsed").textContent).toBe("1:05");
  });

  it("keeps the clock through processing", () => {
    render(<RecordingStatus phase="processing" elapsedSeconds={300} />);
    expect(screen.getByTestId("recording-elapsed").textContent).toBe("5:00");
    expect(screen.getByTestId("recording-status-pill").textContent).toContain(
      "Processing",
    );
  });

  it("renders the error message on the error phase", () => {
    render(<RecordingStatus phase="error" elapsedSeconds={0} error="capture failed" />);
    const err = screen.getByTestId("recording-error");
    expect(err.textContent).toBe("capture failed");
    expect(err.getAttribute("role")).toBe("alert");
  });

  it("shows the done pill with no clock and no error", () => {
    render(<RecordingStatus phase="done" elapsedSeconds={0} />);
    expect(screen.getByTestId("recording-status-pill").textContent).toContain("Done");
    expect(screen.queryByTestId("recording-elapsed")).toBeNull();
    expect(screen.queryByTestId("recording-error")).toBeNull();
  });
});
