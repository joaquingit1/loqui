import { describe, expect, it } from "vitest";
import {
  transcriptionSettingsSchema,
  updateTranscriptionSettingsSchema,
  transcriptionSettingsToEnv,
  engineUsesModelSize,
  isMacOnlyEngine,
  TRANSCRIPTION_ENV,
  type TranscriptionSettings,
} from "./transcription.js";

describe("transcriptionSettingsSchema (PRD-9) — additive + defaulted", () => {
  it("defaults to faster-whisper / small / auto-detect when absent (old config loads forward)", () => {
    const parsed = transcriptionSettingsSchema.parse({});
    expect(parsed.engine).toBe("faster-whisper");
    expect(parsed.modelSize).toBe("small");
    expect(parsed.language).toBeNull();
  });

  it("round-trips each engine value", () => {
    for (const engine of [
      "faster-whisper",
      "apple-speech",
      "whisperkit",
      "mlx-whisper",
      "parakeet",
    ] as const) {
      const parsed = transcriptionSettingsSchema.parse({ engine });
      expect(parsed.engine).toBe(engine);
      const reparsed = transcriptionSettingsSchema.parse(
        JSON.parse(JSON.stringify(parsed)),
      );
      expect(reparsed.engine).toBe(engine);
    }
  });

  it("rejects an unknown engine", () => {
    expect(() => transcriptionSettingsSchema.parse({ engine: "kaldi" })).toThrow();
  });

  it("partial patch accepts any subset", () => {
    const patch = updateTranscriptionSettingsSchema.parse({ modelSize: "tiny" });
    expect(patch.modelSize).toBe("tiny");
    expect(patch.engine).toBeUndefined();
  });
});

describe("transcriptionSettingsToEnv — the main->sidecar env contract", () => {
  it("maps settings to the LOQUI_TRANSCRIPTION_* env vars", () => {
    const settings: TranscriptionSettings = {
      engine: "whisperkit",
      modelSize: "large",
      language: "es",
    };
    const env = transcriptionSettingsToEnv(settings);
    expect(env[TRANSCRIPTION_ENV.engine]).toBe("whisperkit");
    expect(env[TRANSCRIPTION_ENV.modelSize]).toBe("large");
    expect(env[TRANSCRIPTION_ENV.language]).toBe("es");
  });

  it("encodes a null language as an empty string (auto-detect)", () => {
    const env = transcriptionSettingsToEnv(transcriptionSettingsSchema.parse({}));
    expect(env[TRANSCRIPTION_ENV.language]).toBe("");
  });
});

describe("engine capability helpers", () => {
  it("apple-speech has no selectable model size; the rest do", () => {
    expect(engineUsesModelSize("apple-speech")).toBe(false);
    expect(engineUsesModelSize("faster-whisper")).toBe(true);
    expect(engineUsesModelSize("whisperkit")).toBe(true);
  });

  it("marks the macOS-only engines", () => {
    expect(isMacOnlyEngine("faster-whisper")).toBe(false);
    expect(isMacOnlyEngine("apple-speech")).toBe(true);
    expect(isMacOnlyEngine("parakeet")).toBe(false);
  });
});
