/**
 * PrivacyExportSettings — capture/privacy controls + export folder (PRD-13).
 *
 *   - Hidden from screen sharing: the content-protection toggle (ON by default).
 *     Excludes the Loqui window from screen capture/recording.
 *   - Audio retention: keep / delete-after-processing / never-save. The
 *     never-save option carries a clear note that it disables re-diarization.
 *   - Per-app audio filtering: opt into a per-process system-audio tap where the
 *     OS supports it; the panel shows the resolved capability (full-loopback
 *     fallback when unsupported).
 *   - Export folder: shows the configured export dir + a "Change…" button that
 *     opens the native picker (main owns absolute paths).
 *
 * Talks ONLY to the typed `window.loqui.privacy` + `window.loqui.export` bridges
 * (injectable for tests). No secrets here.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type {
  AudioRetentionPolicy,
  CaptureCapability,
  CaptureSettings,
} from "@loqui/shared";
import type { LoquiExportApi, LoquiPrivacyApi } from "../../preload/index.js";

export interface PrivacyExportSettingsProps {
  /** Privacy bridge. Injectable for tests; defaults to window.loqui.privacy. */
  privacy?: Pick<
    LoquiPrivacyApi,
    "getCaptureSettings" | "setCaptureSettings" | "getCaptureCapability"
  >;
  /** Export bridge. Injectable for tests; defaults to window.loqui.export. */
  exportApi?: Pick<LoquiExportApi, "pickExportDir">;
}

const DEFAULTS: CaptureSettings = {
  contentProtection: true,
  audioRetention: "keep",
  perAppAudioFilter: false,
  exportDir: null,
};

const RETENTION_LABEL: Record<AudioRetentionPolicy, string> = {
  keep: "Keep audio (recommended — enables re-diarization)",
  "delete-after-processing": "Delete audio after processing",
  "never-save": "Never save audio (transcripts only)",
};

export function PrivacyExportSettings({
  privacy,
  exportApi,
}: PrivacyExportSettingsProps): JSX.Element {
  const priv = privacy ?? (typeof window !== "undefined" ? window.loqui?.privacy : undefined);
  const exp = exportApi ?? (typeof window !== "undefined" ? window.loqui?.export : undefined);

  const [settings, setSettings] = useState<CaptureSettings>(DEFAULTS);
  const [capability, setCapability] = useState<CaptureCapability | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!priv?.getCaptureSettings) return;
    let cancelled = false;
    void priv.getCaptureSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });
    void priv.getCaptureCapability?.().then((c) => {
      if (!cancelled) setCapability(c);
    });
    return () => {
      cancelled = true;
    };
  }, [priv]);

  const patch = useCallback(
    async (next: Partial<CaptureSettings>) => {
      if (!priv?.setCaptureSettings) return;
      const updated = await priv.setCaptureSettings(next);
      setSettings(updated);
      setStatus("Saved");
      if (next.perAppAudioFilter !== undefined) {
        const cap = await priv.getCaptureCapability?.();
        if (cap) setCapability(cap);
      }
    },
    [priv],
  );

  const changeDir = useCallback(async () => {
    const dir = await exp?.pickExportDir?.();
    if (dir) setSettings((s) => ({ ...s, exportDir: dir }));
  }, [exp]);

  return (
    <section className="panel" aria-labelledby="privacy-title" data-testid="privacy-settings">
      <h2 className="panel__title" id="privacy-title">
        Privacy &amp; Export
      </h2>

      <label className="settings__row">
        <input
          type="checkbox"
          data-testid="content-protection-toggle"
          checked={settings.contentProtection}
          onChange={(e) => void patch({ contentProtection: e.target.checked })}
        />
        <span>Hide window from screen sharing</span>
      </label>

      <label className="settings__row">
        <span>Audio retention</span>
        <select
          data-testid="audio-retention-select"
          value={settings.audioRetention}
          onChange={(e) =>
            void patch({ audioRetention: e.target.value as AudioRetentionPolicy })
          }
        >
          {(Object.keys(RETENTION_LABEL) as AudioRetentionPolicy[]).map((p) => (
            <option key={p} value={p}>
              {RETENTION_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      {settings.audioRetention === "never-save" && (
        <p className="settings__note" data-testid="never-save-note">
          Audio is streamed for transcription but never written to disk. Re-diarizing this
          meeting later will not be possible.
        </p>
      )}

      <label className="settings__row">
        <input
          type="checkbox"
          data-testid="per-app-filter-toggle"
          checked={settings.perAppAudioFilter}
          onChange={(e) => void patch({ perAppAudioFilter: e.target.checked })}
        />
        <span>Capture only the meeting app&apos;s audio (where supported)</span>
      </label>
      {capability && (
        <p className="settings__note" data-testid="capture-capability">
          {capability.mode === "per-app"
            ? "Per-app system-audio tap is active."
            : `Using full system loopback. ${capability.reason}`}
        </p>
      )}

      <div className="settings__row">
        <span>Export folder</span>
        <code data-testid="export-dir">{settings.exportDir ?? "Default (…/Loqui/exports)"}</code>
        <button type="button" data-testid="change-export-dir" onClick={() => void changeDir()}>
          Change…
        </button>
      </div>

      {status && <p className="settings__status">{status}</p>}
    </section>
  );
}
