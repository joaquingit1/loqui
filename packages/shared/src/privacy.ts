/**
 * PRD-13 shared capture/privacy settings contract.
 *
 * Defined ONCE in @loqui/shared so the renderer, preload bridge, main IPC
 * handlers + the settings store all type against a single source. Every field is
 * ADDITIVE + DEFAULTED so an older `app-settings.json` (written before a field
 * existed, or partial input from a caller) parses forward without error.
 *
 * These settings govern three privacy/capture controls:
 *
 *   - contentProtection — exclude the Loqui window(s) from screen
 *     capture/recording via `BrowserWindow.setContentProtection(true)`.
 *     ON BY DEFAULT (cross-platform: Keychain-backed on macOS, SetWindowDisplay
 *     Affinity on Windows; Electron handles the platform call).
 *
 *   - audioRetention — what to do with the per-source WAVs (mic.wav/system.wav):
 *       keep (default)            — persist the WAVs (needed for re-diarization).
 *       delete-after-processing   — remove the WAVs once diarization (PRD-5) has
 *                                   consumed them (after `postProcessDone`).
 *       never-save                — stream to transcription WITHOUT persisting
 *                                   the WAVs (disables post-hoc re-diarization;
 *                                   the UI notes this clearly).
 *
 *   - perAppAudioFilter — capture only the meeting app's system audio where the
 *     OS supports a per-process tap; gracefully falls back to full loopback
 *     otherwise. The capability PROBE + decision is honored in the capture path;
 *     the real per-process tap is a macOS Core Audio / ScreenCaptureKit path
 *     filled in + verified on Mac/CI (see captureCapabilitySchema below).
 *
 *   - exportDir — the configurable export/storage directory for PRD-13 exports.
 *     null => the platform default (`<dataRoot>/exports`).
 */
import { z } from "zod";

/**
 * Audio-retention policy for the per-source WAVs. Defaulted to `keep` so an
 * older config (and the privacy-preserving baseline) keeps the WAVs for
 * re-diarization. See the file header for the per-value semantics.
 */
export const audioRetentionPolicySchema = z
  .enum(["keep", "delete-after-processing", "never-save"])
  .default("keep");
export type AudioRetentionPolicy = z.infer<typeof audioRetentionPolicySchema>;

/**
 * The persisted capture/privacy settings (`<dataRoot>/app-settings.json`). All
 * additive + defaulted so old configs load forward.
 */
export const captureSettingsSchema = z.object({
  /** Exclude the window(s) from screen capture/recording. ON BY DEFAULT. */
  contentProtection: z.boolean().default(true),
  /** WAV retention policy; default keeps the audio (re-diarization friendly). */
  audioRetention: audioRetentionPolicySchema,
  /**
   * Prefer a per-app/per-process system-audio tap when the OS supports it,
   * else full loopback. Default off (full loopback) — the per-process tap is a
   * macOS-only opt-in until the Core Audio / ScreenCaptureKit path is verified.
   */
  perAppAudioFilter: z.boolean().default(false),
  /**
   * Export/storage directory for PRD-13 exports. null => the platform default
   * (`<dataRoot>/exports`). A user-chosen absolute path overrides it.
   */
  exportDir: z.string().nullable().default(null),
});
export type CaptureSettings = z.infer<typeof captureSettingsSchema>;

/** Patch accepted by `setCaptureSettings` — any subset of the fields. */
export const updateCaptureSettingsSchema = captureSettingsSchema.partial();
export type UpdateCaptureSettings = z.infer<typeof updateCaptureSettingsSchema>;

/**
 * Per-app/per-process system-audio capability PROBE result + the resulting
 * capture decision. Computed by the main-process capability probe + the pure
 * decision function (apps/desktop/src/main/capture/perapp.ts) and surfaced to
 * the renderer so the UI can explain the active mode.
 *
 *   supported  — the OS exposes a per-process system-audio tap (macOS 14.4+
 *                Core Audio process taps / ScreenCaptureKit per-process; or
 *                Windows process-loopback on Win10 2004+ when implemented).
 *   mode       — the DECISION: "per-app" when the user opted in AND the OS
 *                supports it; otherwise "full-loopback" (the graceful fallback).
 *   reason     — a short, human-readable note (never a secret) explaining the
 *                decision (e.g. "os unsupported, using full loopback").
 */
export const captureFilterModeSchema = z.enum(["per-app", "full-loopback"]);
export type CaptureFilterMode = z.infer<typeof captureFilterModeSchema>;

export const captureCapabilitySchema = z.object({
  /** Whether the OS exposes a per-process system-audio tap. */
  supported: z.boolean().default(false),
  /** The resolved capture mode after applying the user preference + capability. */
  mode: captureFilterModeSchema.default("full-loopback"),
  /** Human-readable reason for the decision (never a secret). */
  reason: z.string().default(""),
});
export type CaptureCapability = z.infer<typeof captureCapabilitySchema>;
