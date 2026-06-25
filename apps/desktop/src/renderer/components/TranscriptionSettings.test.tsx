/**
 * TranscriptionSettings tests (jsdom, hermetic): loads + patches engine/model/
 * language via the transcription bridge, hides the model picker for Apple Speech,
 * and disables macOS-only engines on Windows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TranscriptionEngineInfo, TranscriptionSettings as T } from "@loqui/shared";
import { TranscriptionSettings } from "./TranscriptionSettings.js";

afterEach(cleanup);

function makeApi(initial: Partial<T> = {}, engines?: TranscriptionEngineInfo[]) {
  let settings: T = {
    engine: "faster-whisper",
    modelSize: "small",
    language: null,
    ...initial,
  };
  const list: TranscriptionEngineInfo[] = engines ?? [
    {
      engine: "faster-whisper",
      label: "Faster-Whisper",
      macOnly: false,
      usesModelSize: true,
      availability: "available",
      note: "",
    },
    {
      engine: "apple-speech",
      label: "Apple Speech",
      macOnly: true,
      usesModelSize: false,
      availability: "unsupported-os",
      note: "macOS-only — falls back to Faster-Whisper here",
    },
  ];
  return {
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (patch: Partial<T>) => {
      settings = { ...settings, ...patch };
      return settings;
    }),
    getEngines: vi.fn(async () => list),
  };
}

describe("TranscriptionSettings", () => {
  it("loads the current engine and patches a new selection", async () => {
    const api = makeApi();
    render(<TranscriptionSettings api={api} />);
    await waitFor(() =>
      expect((screen.getByTestId("transcription-engine-select") as HTMLSelectElement).value).toBe(
        "faster-whisper",
      ),
    );
    fireEvent.change(screen.getByTestId("transcription-engine-select"), {
      target: { value: "apple-speech" },
    });
    await waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith({ engine: "apple-speech" }),
    );
  });

  it("hides the model picker for Apple Speech (no selectable model)", async () => {
    const api = makeApi({ engine: "apple-speech" });
    render(<TranscriptionSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("transcription-settings")).toBeTruthy());
    expect(screen.queryByTestId("transcription-model-select")).toBeNull();
  });

  it("shows the model picker for faster-whisper and patches it", async () => {
    const api = makeApi();
    render(<TranscriptionSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("transcription-model-select")).toBeTruthy());
    fireEvent.change(screen.getByTestId("transcription-model-select"), {
      target: { value: "large" },
    });
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({ modelSize: "large" }));
  });

  it("disables a macOS-only engine option on this (Windows) host", async () => {
    const api = makeApi();
    render(<TranscriptionSettings api={api} />);
    await waitFor(() => {
      const opts = Array.from(
        (screen.getByTestId("transcription-engine-select") as HTMLSelectElement).options,
      );
      const apple = opts.find((o) => o.value === "apple-speech");
      expect(apple?.disabled).toBe(true);
    });
  });

  it("encodes an empty language input as auto-detect (null)", async () => {
    const api = makeApi({ language: "en" });
    render(<TranscriptionSettings api={api} />);
    await waitFor(() => expect(screen.getByTestId("transcription-language-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("transcription-language-input"), {
      target: { value: "  " },
    });
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({ language: null }));
  });
});
