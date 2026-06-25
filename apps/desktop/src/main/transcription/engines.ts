/**
 * PRD-9 — the selectable-engine list the Settings UI renders.
 *
 * A PURE builder (no electron/node side effects beyond the platform string) that
 * folds the host platform into a {@link TranscriptionEngineInfo}[] so the UI can
 * show each engine with a label + availability badge, hiding/disabling the
 * macOS-only engines on Windows. The sidecar makes the final runtime call (its
 * capability probe) — this is the UI-facing preview.
 */
import {
  engineUsesModelSize,
  isMacOnlyEngine,
  type TranscriptionEngine,
  type TranscriptionEngineAvailability,
  type TranscriptionEngineInfo,
} from "@loqui/shared";

/** Display labels for each engine. */
const ENGINE_LABEL: Record<TranscriptionEngine, string> = {
  "faster-whisper": "Faster-Whisper (cross-platform, CPU)",
  "apple-speech": "Apple Speech (on-device, zero download)",
  whisperkit: "WhisperKit (Apple Silicon, ANE)",
  "mlx-whisper": "MLX-Whisper (Apple Silicon, ANE)",
  parakeet: "NVIDIA Parakeet (experimental)",
};

const ALL_ENGINES: TranscriptionEngine[] = [
  "faster-whisper",
  "apple-speech",
  "whisperkit",
  "mlx-whisper",
  "parakeet",
];

/**
 * Build the engine list for `platform` (a `process.platform` value). The
 * cross-platform faster-whisper is always `available`; macOS-only engines are
 * `unsupported-os` off darwin (so the UI disables them) and `needs-permission`
 * (Apple Speech) / `needs-download` (WhisperKit/MLX) on darwin — a best-effort,
 * UI-facing hint; the sidecar's probe is authoritative at runtime.
 */
export function buildEngineList(platform: string): TranscriptionEngineInfo[] {
  const isMac = platform === "darwin";
  return ALL_ENGINES.map((engine) => {
    let availability: TranscriptionEngineAvailability = "available";
    let note = "";
    if (engine === "faster-whisper") {
      availability = "available";
    } else if (isMacOnlyEngine(engine) && !isMac) {
      availability = "unsupported-os";
      note = "macOS-only — falls back to Faster-Whisper here";
    } else if (engine === "parakeet") {
      availability = "helper-missing";
      note = "Experimental — requires a GPU/ANE path";
    } else if (engine === "apple-speech") {
      availability = "needs-permission";
      note = "Requires Speech Recognition permission (granted on first use)";
    } else {
      // whisperkit / mlx-whisper on macOS.
      availability = "needs-download";
      note = "Downloads a CoreML model on first use";
    }
    return {
      engine,
      label: ENGINE_LABEL[engine],
      macOnly: isMacOnlyEngine(engine),
      usesModelSize: engineUsesModelSize(engine),
      availability,
      note,
    };
  });
}
