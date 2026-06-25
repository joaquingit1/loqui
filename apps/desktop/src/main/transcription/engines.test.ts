/**
 * PRD-9 engine-list builder tests: the UI-facing engine list + availability.
 */
import { describe, expect, it } from "vitest";
import { buildEngineList } from "./engines.js";

describe("buildEngineList (PRD-9)", () => {
  it("always lists faster-whisper as available cross-platform", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      const list = buildEngineList(platform);
      const fw = list.find((e) => e.engine === "faster-whisper");
      expect(fw?.availability).toBe("available");
      expect(fw?.macOnly).toBe(false);
      expect(fw?.usesModelSize).toBe(true);
    }
  });

  it("marks macOS-only engines unsupported on Windows", () => {
    const list = buildEngineList("win32");
    for (const engine of ["apple-speech", "whisperkit", "mlx-whisper"] as const) {
      const info = list.find((e) => e.engine === engine);
      expect(info?.macOnly).toBe(true);
      expect(info?.availability).toBe("unsupported-os");
      expect(info?.note).toContain("macOS-only");
    }
  });

  it("flags Apple Speech as needs-permission + no model size on macOS", () => {
    const apple = buildEngineList("darwin").find((e) => e.engine === "apple-speech");
    expect(apple?.availability).toBe("needs-permission");
    expect(apple?.usesModelSize).toBe(false);
  });

  it("flags WhisperKit/MLX as needs-download on macOS", () => {
    const list = buildEngineList("darwin");
    for (const engine of ["whisperkit", "mlx-whisper"] as const) {
      const info = list.find((e) => e.engine === engine);
      expect(info?.availability).toBe("needs-download");
      expect(info?.usesModelSize).toBe(true);
    }
  });

  it("includes all five engines", () => {
    const list = buildEngineList("darwin");
    expect(list.map((e) => e.engine).sort()).toEqual(
      ["apple-speech", "faster-whisper", "mlx-whisper", "parakeet", "whisperkit"].sort(),
    );
  });
});
