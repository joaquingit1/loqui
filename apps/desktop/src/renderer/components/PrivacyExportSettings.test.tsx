/**
 * PrivacyExportSettings tests (jsdom, hermetic): loads + patches settings via the
 * privacy bridge, shows the never-save note + the per-app capability message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CaptureSettings } from "@loqui/shared";
import { PrivacyExportSettings } from "./PrivacyExportSettings.js";

afterEach(cleanup);

function makePrivacy(initial: Partial<CaptureSettings> = {}) {
  let settings: CaptureSettings = {
    contentProtection: true,
    audioRetention: "keep",
    perAppAudioFilter: false,
    exportDir: null,
    ...initial,
  };
  return {
    getCaptureSettings: vi.fn(async () => settings),
    setCaptureSettings: vi.fn(async (patch: Partial<CaptureSettings>) => {
      settings = { ...settings, ...patch };
      return settings;
    }),
    getCaptureCapability: vi.fn(async () => ({
      supported: false,
      mode: "full-loopback" as const,
      reason: "per-app filtering not supported on win32; falling back to full loopback",
    })),
  };
}

describe("PrivacyExportSettings", () => {
  it("loads settings and toggles content protection", async () => {
    const privacy = makePrivacy();
    render(<PrivacyExportSettings privacy={privacy} exportApi={{ pickExportDir: vi.fn() }} />);

    await waitFor(() => {
      expect((screen.getByTestId("content-protection-toggle") as HTMLInputElement).checked).toBe(
        true,
      );
    });
    fireEvent.click(screen.getByTestId("content-protection-toggle"));
    await waitFor(() =>
      expect(privacy.setCaptureSettings).toHaveBeenCalledWith({ contentProtection: false }),
    );
  });

  it("shows the never-save note when retention is never-save", async () => {
    const privacy = makePrivacy({ audioRetention: "never-save" });
    render(<PrivacyExportSettings privacy={privacy} exportApi={{ pickExportDir: vi.fn() }} />);
    await waitFor(() => expect(screen.getByTestId("never-save-note")).toBeTruthy());
  });

  it("surfaces the per-app capability fallback message", async () => {
    const privacy = makePrivacy();
    render(<PrivacyExportSettings privacy={privacy} exportApi={{ pickExportDir: vi.fn() }} />);
    await waitFor(() => {
      expect(screen.getByTestId("capture-capability").textContent).toContain("full system loopback");
    });
  });
});
