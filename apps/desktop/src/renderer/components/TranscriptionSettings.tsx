/**
 * TranscriptionSettings — pluggable transcription-engine controls (PRD-9).
 *
 *   - Engine: pick faster-whisper (default, cross-platform) or a macOS-native
 *     on-device engine (Apple Speech / WhisperKit / MLX). macOS-only engines are
 *     DISABLED (with a note) on Windows so the UI never offers a choice that
 *     can't run — the sidecar would fall back to faster-whisper anyway.
 *   - Model size: tiny…large, hidden for Apple Speech (zero-download, no model).
 *   - Language: a hint (or auto-detect).
 *   - Each engine row shows an availability badge + note (download/permission/
 *     unsupported-OS), driven by the main-process probe.
 *
 * A change takes effect for the NEXT meeting (the sidecar reads the engine at
 * launch). Talks ONLY to the typed `window.loqui.transcription` bridge
 * (injectable for tests). No secrets here.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type {
  TranscriptionEngine,
  TranscriptionEngineInfo,
  TranscriptionModelSize,
  TranscriptionSettings as TranscriptionSettingsT,
} from "@loqui/shared";
import { engineUsesModelSize } from "@loqui/shared";
import type { LoquiTranscriptionApi } from "../../preload/index.js";

export interface TranscriptionSettingsProps {
  /** Transcription bridge. Injectable for tests; defaults to window.loqui.transcription. */
  api?: Pick<LoquiTranscriptionApi, "getSettings" | "setSettings" | "getEngines">;
}

const DEFAULTS: TranscriptionSettingsT = {
  engine: "faster-whisper",
  modelSize: "small",
  language: null,
};

const MODEL_SIZES: TranscriptionModelSize[] = ["tiny", "base", "small", "medium", "large"];

const AVAILABILITY_LABEL: Record<string, string> = {
  available: "Available",
  "unsupported-os": "Not on this OS",
  "helper-missing": "Unavailable",
  "needs-permission": "Needs permission",
  "needs-download": "Downloads on first use",
};

export function TranscriptionSettings({ api }: TranscriptionSettingsProps): JSX.Element {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.transcription : undefined);

  const [settings, setSettings] = useState<TranscriptionSettingsT>(DEFAULTS);
  const [engines, setEngines] = useState<TranscriptionEngineInfo[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge?.getSettings) return;
    let cancelled = false;
    void bridge.getSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });
    void bridge.getEngines?.().then((e) => {
      if (!cancelled) setEngines(e);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const patch = useCallback(
    async (next: Partial<TranscriptionSettingsT>) => {
      if (!bridge?.setSettings) return;
      const updated = await bridge.setSettings(next);
      setSettings(updated);
      setStatus("Saved — applies to your next meeting");
    },
    [bridge],
  );

  const selectedInfo = engines.find((e) => e.engine === settings.engine);
  const showModelSize = engineUsesModelSize(settings.engine);

  return (
    <section
      className="panel"
      aria-labelledby="transcription-title"
      data-testid="transcription-settings"
    >
      <h2 className="panel__title" id="transcription-title">
        Transcription Engine
      </h2>

      <label className="settings__row">
        <span>Engine</span>
        <select
          data-testid="transcription-engine-select"
          value={settings.engine}
          onChange={(e) => void patch({ engine: e.target.value as TranscriptionEngine })}
        >
          {(engines.length > 0
            ? engines
            : [{ engine: "faster-whisper", label: "Faster-Whisper", availability: "available" } as TranscriptionEngineInfo]
          ).map((info) => {
            const disabled =
              info.availability === "unsupported-os" || info.availability === "helper-missing";
            return (
              <option key={info.engine} value={info.engine} disabled={disabled}>
                {info.label || info.engine}
                {disabled ? " (unavailable here)" : ""}
              </option>
            );
          })}
        </select>
      </label>

      {selectedInfo?.note && (
        <p className="settings__note" data-testid="transcription-engine-note">
          {AVAILABILITY_LABEL[selectedInfo.availability] ?? selectedInfo.availability}
          {selectedInfo.note ? ` — ${selectedInfo.note}` : ""}
        </p>
      )}

      {showModelSize && (
        <label className="settings__row">
          <span>Model size</span>
          <select
            data-testid="transcription-model-select"
            value={settings.modelSize}
            onChange={(e) =>
              void patch({ modelSize: e.target.value as TranscriptionModelSize })
            }
          >
            {MODEL_SIZES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="settings__row">
        <span>Language</span>
        <input
          type="text"
          data-testid="transcription-language-input"
          placeholder="auto-detect"
          value={settings.language ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            void patch({ language: v === "" ? null : v });
          }}
        />
      </label>

      {status && <p className="settings__status">{status}</p>}
    </section>
  );
}
