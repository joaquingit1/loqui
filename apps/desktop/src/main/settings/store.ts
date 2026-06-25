/**
 * Capture/privacy + export settings store (PRD-13).
 *
 * Import as: `import { SettingsStore } from "../settings/store.js"`
 *
 * Persists the non-secret {@link CaptureSettings} (content-protection toggle,
 * audio-retention policy, per-app audio filter, export dir) as plain JSON under
 * the resolved data root (honoring LOQUI_DATA_DIR so tests stay hermetic):
 *
 *   <dataRoot>/app-settings.json   — { capture: CaptureSettings }
 *
 * Mirrors the PRD-4 keystore pattern (a single JSON file, validated + defaulted
 * on read) but holds NO secrets, so there is no safeStorage involvement. Every
 * field is additive + defaulted via the shared zod schema, so an older
 * app-settings.json (or a missing file) loads forward with the defaults
 * (content-protection ON, retention "keep", per-app filter off).
 *
 * READ-ONLY over the transcript: this module cannot read or write a
 * transcript/meta file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureSettingsSchema,
  updateCaptureSettingsSchema,
  autoRecordSettingsSchema,
  updateAutoRecordSettingsSchema,
  updaterSettingsSchema,
  updateUpdaterSettingsSchema,
  transcriptionSettingsSchema,
  updateTranscriptionSettingsSchema,
  type CaptureSettings,
  type UpdateCaptureSettings,
  type AutoRecordSettings,
  type UpdateAutoRecordSettings,
  type UpdaterSettings,
  type UpdateUpdaterSettings,
  type TranscriptionSettings,
  type UpdateTranscriptionSettings,
} from "@loqui/shared";
import { dataRoot } from "../store/paths.js";

const APP_SETTINGS_FILE = "app-settings.json";

/** On-disk shape of `app-settings.json`. */
interface AppSettingsFile {
  capture?: unknown;
  /** PRD-11 auto-record + tray policy (additive; absent => all-defaults = off). */
  autoRecord?: unknown;
  /** PRD-8 updater policy (additive; absent => all-defaults = auto-check on). */
  updater?: unknown;
  /** PRD-9 transcription-engine policy (additive; absent => default faster-whisper). */
  transcription?: unknown;
}

function appSettingsPath(): string {
  return join(dataRoot(), APP_SETTINGS_FILE);
}

/** `<dataRoot>/exports` — the default export directory when none is configured. */
export function defaultExportDir(): string {
  return join(dataRoot(), "exports");
}

export class SettingsStore {
  /** Read the persisted capture/privacy settings (validated + defaulted). */
  getCaptureSettings(): CaptureSettings {
    const file = this.#readFile();
    return captureSettingsSchema.parse(file.capture ?? {});
  }

  /**
   * Patch the capture/privacy settings (any subset of fields). Merges over the
   * current settings, re-validates, persists, and returns the stored value.
   */
  setCaptureSettings(patch: UpdateCaptureSettings): CaptureSettings {
    const clean = updateCaptureSettingsSchema.parse(patch ?? {});
    const current = this.getCaptureSettings();
    const merged = captureSettingsSchema.parse({ ...current, ...clean });
    const file = this.#readFile();
    file.capture = merged;
    this.#writeFile(file);
    return merged;
  }

  /**
   * Read the persisted auto-record + tray settings (PRD-11; validated +
   * defaulted). An older `app-settings.json` (or a missing `autoRecord` key)
   * parses forward to the all-defaults value — which is MANUAL-ONLY (enabled:
   * false), preserving PRD-3 behavior.
   */
  getAutoRecordSettings(): AutoRecordSettings {
    const file = this.#readFile();
    return autoRecordSettingsSchema.parse(file.autoRecord ?? {});
  }

  /**
   * Patch the auto-record + tray settings (any subset). Merges over the current
   * settings, re-validates, persists, and returns the stored value.
   */
  setAutoRecordSettings(patch: UpdateAutoRecordSettings): AutoRecordSettings {
    const clean = updateAutoRecordSettingsSchema.parse(patch ?? {});
    const current = this.getAutoRecordSettings();
    const merged = autoRecordSettingsSchema.parse({ ...current, ...clean });
    const file = this.#readFile();
    file.autoRecord = merged;
    this.#writeFile(file);
    return merged;
  }

  /**
   * Read the persisted updater settings (PRD-8; validated + defaulted). An older
   * `app-settings.json` (or a missing `updater` key) parses forward to the
   * all-defaults value (auto-check ON, ~30 min interval, auto-download ON).
   */
  getUpdaterSettings(): UpdaterSettings {
    const file = this.#readFile();
    return updaterSettingsSchema.parse(file.updater ?? {});
  }

  /**
   * Patch the updater settings (any subset). Merges over the current settings,
   * re-validates, persists, and returns the stored value.
   */
  setUpdaterSettings(patch: UpdateUpdaterSettings): UpdaterSettings {
    const clean = updateUpdaterSettingsSchema.parse(patch ?? {});
    const current = this.getUpdaterSettings();
    const merged = updaterSettingsSchema.parse({ ...current, ...clean });
    const file = this.#readFile();
    file.updater = merged;
    this.#writeFile(file);
    return merged;
  }

  /**
   * Read the persisted transcription-engine settings (PRD-9; validated +
   * defaulted). An older `app-settings.json` (or a missing `transcription` key)
   * parses forward to the all-defaults value (engine faster-whisper, model
   * `small`, language auto-detect) — byte-identical to the existing PRD-2 flow.
   */
  getTranscriptionSettings(): TranscriptionSettings {
    const file = this.#readFile();
    return transcriptionSettingsSchema.parse(file.transcription ?? {});
  }

  /**
   * Patch the transcription-engine settings (any subset). Merges over the
   * current settings, re-validates, persists, and returns the stored value. The
   * change takes effect for the NEXT meeting (the sidecar reads the engine at
   * launch via the LOQUI_TRANSCRIPTION_* env contract).
   */
  setTranscriptionSettings(patch: UpdateTranscriptionSettings): TranscriptionSettings {
    const clean = updateTranscriptionSettingsSchema.parse(patch ?? {});
    const current = this.getTranscriptionSettings();
    const merged = transcriptionSettingsSchema.parse({ ...current, ...clean });
    const file = this.#readFile();
    file.transcription = merged;
    this.#writeFile(file);
    return merged;
  }

  /** The configured export directory, or the platform default when unset. */
  getExportDir(): string {
    const dir = this.getCaptureSettings().exportDir;
    return dir && dir.trim() !== "" ? dir : defaultExportDir();
  }

  #readFile(): AppSettingsFile {
    try {
      const raw = readFileSync(appSettingsPath(), "utf8");
      const parsed = JSON.parse(raw) as AppSettingsFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      // Corrupt file: start fresh rather than crash the settings surface.
      return {};
    }
  }

  #writeFile(file: AppSettingsFile): void {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(appSettingsPath(), JSON.stringify(file, null, 2), "utf8");
  }
}
