/**
 * PRD-9 — shared pluggable-transcription-engine contract seams.
 *
 * The single source of truth for the cross-process shapes the engine selector
 * types against. Kept in @loqui/shared (zod + emitted JSON Schema) so main,
 * preload, the renderer Settings UI, and — via the emitted JSON Schemas + the
 * `LOQUI_TRANSCRIPTION_*` env contract below — the Python sidecar all agree on
 * ONE definition. @loqui/shared stays zod-only — NO node/electron deps here.
 *
 *   - {@link TranscriptionEngine} — the user-selectable engine id. `faster-whisper`
 *     is the DEFAULT and the only cross-platform engine; `apple-speech`,
 *     `whisperkit`, and `mlx-whisper` are macOS/Apple-Silicon on-device engines
 *     (gracefully absent on Windows). `parakeet` is the stretch GPU/ANE engine.
 *   - {@link TranscriptionSettings} — the persisted, additive + defaulted policy
 *     (`<dataRoot>/app-settings.json` under the `transcription` key): engine +
 *     per-engine model size + language. DEFAULTS to faster-whisper / `small` /
 *     auto-detect so an older config (and the existing PRD-2 flow) is byte-identical.
 *   - {@link TranscriptionEngineInfo} — one entry of the availability/permission
 *     PROBE the Settings UI renders: whether THIS engine is available on this
 *     OS/arch, whether it needs a model download or a permission, and a short note.
 *   - {@link TranscriptionStatus} — the resolved runtime status surfaced to the UI
 *     + `/health`: which engine actually loaded, whether a fallback occurred, and
 *     the human-readable reason (e.g. "apple-speech unavailable on win32 — using
 *     faster-whisper").
 *
 * INVARIANT #4 (cross-platform, no engine choice ever breaks a meeting): the
 * selector ALWAYS falls back to faster-whisper when the chosen engine is
 * unavailable (Windows, no helper, or the capability probe says no). The
 * two-stream You/They model is untouched: each (meeting, source) still runs its
 * own pipeline.
 *
 * Every field is ADDITIVE + DEFAULTED so a partial payload / older config parses
 * forward (mirroring CaptureSettings / AutoRecordSettings / UpdaterSettings).
 */
import { z } from "zod";

// --- The selectable engines ---------------------------------------------------

/**
 * The set of transcription engines a user can pick. `faster-whisper` is the
 * cross-platform default; the rest are macOS/Apple-Silicon on-device engines
 * (and `parakeet`, the stretch GPU/ANE engine). The selector hides/disables the
 * macOS-only ones on Windows and ALWAYS falls back to faster-whisper when a
 * chosen engine is unavailable, so no choice ever breaks a meeting.
 */
export const transcriptionEngineSchema = z
  .enum(["faster-whisper", "apple-speech", "whisperkit", "mlx-whisper", "parakeet"])
  .default("faster-whisper");
export type TranscriptionEngine = z.infer<typeof transcriptionEngineSchema>;

/** The default engine — cross-platform, zero macOS dependency. */
export const DEFAULT_TRANSCRIPTION_ENGINE = "faster-whisper" as const;

/**
 * Engines that run ONLY on macOS (Apple Silicon for the ANE-accelerated ones).
 * The Settings UI hides/disables these on Windows; the sidecar selector falls
 * back to faster-whisper for them on any non-macOS host.
 */
export const MACOS_ONLY_ENGINES: readonly TranscriptionEngine[] = [
  "apple-speech",
  "whisperkit",
  "mlx-whisper",
];

/**
 * Whisper model sizes (shared by faster-whisper + the WhisperKit/MLX engines).
 * `apple-speech` ignores this (it has no selectable model — zero download), so
 * the UI hides the model picker for it. Defaulted to `small` (the PRD-2 default).
 */
export const transcriptionModelSizeSchema = z
  .enum(["tiny", "base", "small", "medium", "large"])
  .default("small");
export type TranscriptionModelSize = z.infer<typeof transcriptionModelSizeSchema>;

/**
 * Whether an engine even uses a selectable Whisper model size. `apple-speech`
 * does not (it is zero-download, fixed on-device). Used by the UI to hide the
 * model picker and by the selector to ignore `modelSize` for that engine.
 */
export function engineUsesModelSize(engine: TranscriptionEngine): boolean {
  return engine !== "apple-speech";
}

/**
 * Whether an engine is macOS-only (gracefully absent on Windows). Pure helper so
 * the UI and the selector agree.
 */
export function isMacOnlyEngine(engine: TranscriptionEngine): boolean {
  return MACOS_ONLY_ENGINES.includes(engine);
}

// --- The persisted settings (additive + defaulted) ----------------------------

/**
 * The persisted transcription-engine settings (`<dataRoot>/app-settings.json`
 * under the `transcription` key). All additive + defaulted so an older config
 * (or the existing PRD-2 flow that never wrote this key) loads forward to the
 * faster-whisper default — byte-identical to today's behavior.
 *
 * A change takes effect for the NEXT meeting (the sidecar reads these at launch
 * via the {@link TRANSCRIPTION_ENV} env contract; the running pipeline is never
 * swapped mid-meeting).
 */
export const transcriptionSettingsSchema = z.object({
  /** The selected engine. DEFAULT faster-whisper (cross-platform). */
  engine: transcriptionEngineSchema,
  /**
   * The Whisper model size for engines that use one (faster-whisper / WhisperKit
   * / MLX). Ignored by `apple-speech`. Default `small`.
   */
  modelSize: transcriptionModelSizeSchema,
  /**
   * BCP-47 language hint (e.g. "en", "es"), or null to auto-detect. Default null
   * (auto-detect) — matches the PRD-2 `language=None` default.
   */
  language: z.string().nullable().default(null),
});
export type TranscriptionSettings = z.infer<typeof transcriptionSettingsSchema>;

/** Patch accepted by `setTranscriptionSettings` — any subset of the fields. */
export const updateTranscriptionSettingsSchema = transcriptionSettingsSchema.partial();
export type UpdateTranscriptionSettings = z.infer<typeof updateTranscriptionSettingsSchema>;

// --- The availability / permission probe (surfaced to the Settings UI) --------

/** Why an engine is or is not usable right now (drives the UI badge + note). */
export const transcriptionEngineAvailabilitySchema = z.enum([
  /** Ready to use now (cross-platform faster-whisper, or a present macOS engine). */
  "available",
  /** The OS/arch does not support this engine (e.g. an Apple engine on Windows). */
  "unsupported-os",
  /** Supported OS but the native helper/binary is not present (build/packaging). */
  "helper-missing",
  /** Needs a one-time permission grant (e.g. macOS Speech Recognition). */
  "needs-permission",
  /** Needs a one-time model download before first use (WhisperKit/MLX). */
  "needs-download",
]);
export type TranscriptionEngineAvailability = z.infer<
  typeof transcriptionEngineAvailabilitySchema
>;

/**
 * One row of the engine list the Settings UI renders: the engine, a display
 * label, whether it is macOS-only, whether it uses a model size, and its current
 * availability + a short human note. Computed by the main-process probe (which
 * folds in `process.platform`/arch + the sidecar capability probe).
 */
export const transcriptionEngineInfoSchema = z.object({
  engine: transcriptionEngineSchema,
  /** Human-facing label (e.g. "Apple Speech (on-device)"). */
  label: z.string().default(""),
  /** macOS-only engines are hidden/disabled on Windows. */
  macOnly: z.boolean().default(false),
  /** Whether the engine exposes a selectable Whisper model size. */
  usesModelSize: z.boolean().default(true),
  /** Whether the engine is available, and if not, why. */
  availability: transcriptionEngineAvailabilitySchema.default("available"),
  /** Short, human-readable note (never a secret). */
  note: z.string().default(""),
});
export type TranscriptionEngineInfo = z.infer<typeof transcriptionEngineInfoSchema>;

/**
 * The resolved runtime status: which engine was REQUESTED, which actually
 * loaded, whether a fallback occurred, and why. Surfaced to the UI + `/health`
 * so a Windows user who picked an Apple engine sees "using faster-whisper".
 */
export const transcriptionStatusSchema = z.object({
  /** The engine the user selected. */
  requestedEngine: transcriptionEngineSchema,
  /** The engine actually in use (== requested, unless a fallback happened). */
  activeEngine: transcriptionEngineSchema,
  /** True when the active engine differs from the requested one. */
  fellBack: z.boolean().default(false),
  /** Human-readable reason for a fallback (empty when none). */
  reason: z.string().default(""),
});
export type TranscriptionStatus = z.infer<typeof transcriptionStatusSchema>;

// --- The cross-process env contract (main -> sidecar) -------------------------

/**
 * Env-var names the main process sets when spawning the sidecar so the sidecar
 * selects the same engine the user chose. This mirrors the `LOQUI_DATA_DIR`
 * agreement (a per-launch env var) rather than adding a new WS message, because
 * the engine choice "takes effect for the NEXT meeting" — i.e. the next sidecar
 * launch — and never needs to change a RUNNING pipeline. The sidecar reads these
 * in its engine selector (see `loqui_sidecar/transcription/engine_select.py`).
 *
 * `LOQUI_FAKE_ASR` (already defined in PRD-2) still overrides everything for the
 * hermetic gate, so these are inert under the test fake.
 */
export const TRANSCRIPTION_ENV = {
  /** The selected engine id (one of {@link TranscriptionEngine}). */
  engine: "LOQUI_TRANSCRIPTION_ENGINE",
  /** The Whisper model size (ignored by apple-speech). */
  modelSize: "LOQUI_TRANSCRIPTION_MODEL_SIZE",
  /** The language hint ("" => auto-detect). */
  language: "LOQUI_TRANSCRIPTION_LANGUAGE",
} as const;

/**
 * Pure mapper: the persisted {@link TranscriptionSettings} -> the env vars the
 * sidecar reads. Defined here (shared) so main and the tests encode the contract
 * IDENTICALLY. A null language maps to an empty string (auto-detect). Returns
 * only string values (env vars are strings).
 */
export function transcriptionSettingsToEnv(
  settings: TranscriptionSettings,
): Record<string, string> {
  return {
    [TRANSCRIPTION_ENV.engine]: settings.engine,
    [TRANSCRIPTION_ENV.modelSize]: settings.modelSize,
    [TRANSCRIPTION_ENV.language]: settings.language ?? "",
  };
}
