/**
 * Capture UI render/state tests (jsdom). HERMETIC: jsdom has no getUserMedia /
 * AudioWorklet, so we never test real capture — the window.loqui.audio bridge,
 * the controller, and device enumeration are all injected as fakes. These cover
 * RENDER + interaction wiring only (button → controller call, meter display,
 * permission messaging).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AudioSource, LoquiAudioApi } from "@loqui/shared";
import { CapturePanel } from "./CapturePanel.js";
import { CaptureLevelMeter } from "./CaptureLevelMeter.js";
import { CaptureScreenPermission } from "./CaptureScreenPermission.js";
import type {
  CaptureController,
  CaptureControllerDeps,
  CaptureStatus,
  CaptureStatusListener,
} from "../capture/index.js";

afterEach(cleanup);

function fakeAudio(overrides: Partial<LoquiAudioApi> = {}): LoquiAudioApi {
  return {
    startCapture: vi.fn(async () => ({ ok: true })),
    stopCapture: vi.fn(async () => ({ ok: true })),
    sendFrame: vi.fn(),
    getScreenPermission: vi.fn(async () => "not-applicable" as const),
    onScreenPermission: vi.fn(() => () => {}),
    ...overrides,
  };
}

/** A controllable fake controller so we can drive status into the panel. */
function makeFakeController(): {
  factory: (deps: CaptureControllerDeps) => CaptureController;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emit: (source: AudioSource, status: CaptureStatus) => void;
} {
  let listener: CaptureStatusListener | null = null;
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const statuses: Record<AudioSource, CaptureStatus> = {
    mic: { state: "idle", level: 0 },
    system: { state: "idle", level: 0 },
  };
  const controller: CaptureController = {
    start,
    stop,
    stopAll: vi.fn(async () => {}),
    getStatus: (s) => statuses[s],
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };
  const factory = (deps: CaptureControllerDeps) => {
    if (deps.onStatus) listener = deps.onStatus;
    return controller;
  };
  return {
    factory,
    start,
    stop,
    emit: (source, status) => {
      statuses[source] = status;
      listener?.(source, status);
    },
  };
}

describe("CaptureLevelMeter", () => {
  it("renders inactive with no fill", () => {
    render(<CaptureLevelMeter source="mic" level={0} active={false} />);
    const meter = screen.getByTestId("level-meter-mic");
    expect(meter.getAttribute("data-active")).toBe("false");
    expect(meter.querySelector(".meter__fill")?.getAttribute("style")).toContain(
      "width: 0%",
    );
  });

  it("renders active with a level-driven fill and dBFS", () => {
    render(<CaptureLevelMeter source="system" level={0.5} active />);
    const meter = screen.getByTestId("level-meter-system");
    expect(meter.getAttribute("data-active")).toBe("true");
    expect(meter.textContent).toContain("They (system)");
    // sqrt(0.5)*100 ≈ 71%
    expect(meter.querySelector(".meter__fill")?.getAttribute("style")).toContain(
      "width: 71%",
    );
  });
});

describe("CaptureScreenPermission", () => {
  it("renders nothing when granted / not-applicable / null", () => {
    const { container, rerender } = render(<CaptureScreenPermission status="granted" />);
    expect(container.firstChild).toBeNull();
    rerender(<CaptureScreenPermission status="not-applicable" />);
    expect(container.firstChild).toBeNull();
    rerender(<CaptureScreenPermission status={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("warns on denied with a recovery path", () => {
    render(<CaptureScreenPermission status="denied" />);
    const note = screen.getByTestId("screen-permission");
    expect(note.getAttribute("data-status")).toBe("denied");
    expect(note.className).toContain("perm--warn");
    expect(note.textContent).toContain("System Settings");
  });

  it("shows a hard error on restricted", () => {
    render(<CaptureScreenPermission status="restricted" />);
    expect(screen.getByTestId("screen-permission").className).toContain("perm--error");
  });
});

describe("CapturePanel", () => {
  const enumerateDevices = vi.fn(async () => [
    { deviceId: "mic-a", label: "Built-in Mic" },
    { deviceId: "mic-b", label: "USB Mic" },
  ]);

  it("renders disabled prompt with no active meeting", async () => {
    render(
      <CapturePanel
        meetingId={null}
        api={{ audio: fakeAudio() }}
        enumerateDevices={enumerateDevices}
      />,
    );
    expect(screen.getByTestId("capture-panel")).toBeTruthy();
    expect(screen.getByTestId("capture-toggle-mic")).toHaveProperty("disabled", true);
    // Let the device-enumeration + permission effects settle (avoids act warnings).
    await waitFor(() => expect(enumerateDevices).toHaveBeenCalled());
  });

  it("lists enumerated mic devices in the picker", async () => {
    const fc = makeFakeController();
    render(
      <CapturePanel
        meetingId="m1"
        api={{ audio: fakeAudio() }}
        createController={fc.factory}
        enumerateDevices={enumerateDevices}
      />,
    );
    await waitFor(() => expect(screen.getByText("USB Mic")).toBeTruthy());
    expect(screen.getByText("Built-in Mic")).toBeTruthy();
    expect(screen.getByText("System default")).toBeTruthy();
  });

  it("toggles a source: click start calls controller.start, then stop", async () => {
    const fc = makeFakeController();
    render(
      <CapturePanel
        meetingId="m1"
        api={{ audio: fakeAudio() }}
        createController={fc.factory}
        enumerateDevices={enumerateDevices}
      />,
    );
    fireEvent.click(screen.getByTestId("capture-toggle-mic"));
    expect(fc.start).toHaveBeenCalledWith("mic");

    // Drive status to capturing; the button should now stop.
    act(() => fc.emit("mic", { state: "capturing", level: 0.2 }));
    await waitFor(() =>
      expect(screen.getByTestId("capture-toggle-mic").textContent).toContain("Stop"),
    );
    fireEvent.click(screen.getByTestId("capture-toggle-mic"));
    expect(fc.stop).toHaveBeenCalledWith("mic");
  });

  it("reflects a per-source error message", async () => {
    const fc = makeFakeController();
    render(
      <CapturePanel
        meetingId="m1"
        api={{ audio: fakeAudio() }}
        createController={fc.factory}
        enumerateDevices={enumerateDevices}
      />,
    );
    act(() =>
      fc.emit("system", { state: "error", level: 0, error: "no system-audio track" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("capture-error-system").textContent).toContain(
        "no system-audio track",
      ),
    );
  });

  it("disables the system control + shows the notice when screen recording is restricted", async () => {
    const fc = makeFakeController();
    render(
      <CapturePanel
        meetingId="m1"
        api={{
          audio: fakeAudio({
            getScreenPermission: vi.fn(async () => "restricted" as const),
          }),
        }}
        createController={fc.factory}
        enumerateDevices={enumerateDevices}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("capture-toggle-system")).toHaveProperty(
        "disabled",
        true,
      ),
    );
    expect(screen.getByTestId("screen-permission").className).toContain("perm--error");
    // mic is still enabled.
    expect(screen.getByTestId("capture-toggle-mic")).toHaveProperty("disabled", false);
  });
});
