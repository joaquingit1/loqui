/**
 * Dual-stream capture panel (PRD-1).
 *
 * Composes the mic device picker, per-source start/stop controls, two
 * INDEPENDENT live level meters (mic = "You", system = "They"), and the macOS
 * Screen-Recording permission messaging. All capture state is owned by the
 * useCapture hook (controller); this component is the presentation + wiring.
 *
 * The system-audio control is disabled when Screen Recording is hard-blocked
 * (`restricted`) and warns when `denied` — the mic stream always works.
 */
import { useCallback, useEffect, useState } from "react";
import type { AudioSource } from "@loqui/shared";
import type { LoquiApi } from "../../preload/index.js";
import {
  listAudioInputs,
  useCapture,
  type AudioInputDevice,
  type CaptureControllerDeps,
  type CaptureController,
} from "../capture/index.js";
import { CaptureLevelMeter } from "./CaptureLevelMeter.js";
import { CaptureScreenPermission } from "./CaptureScreenPermission.js";
import "../capture/capture.css";

export interface CapturePanelProps {
  /** The active meeting to capture into; null disables the controls. */
  meetingId: string | null;
  /** Injectable for tests; defaults to window.loqui. */
  api?: Pick<LoquiApi, "audio">;
  /** Inject a controller factory for tests (defaults to the real one). */
  createController?: (deps: CaptureControllerDeps) => CaptureController;
  /** Inject device enumeration for tests. */
  enumerateDevices?: () => Promise<AudioInputDevice[]>;
}

const SOURCE_BUTTON_LABEL: Record<AudioSource, string> = {
  mic: "You (mic)",
  system: "They (system)",
};

export function CapturePanel({
  meetingId,
  api,
  createController,
  enumerateDevices,
}: CapturePanelProps): JSX.Element {
  const audio = (api ?? (typeof window !== "undefined" ? window.loqui : undefined))
    ?.audio;
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const load = enumerateDevices ?? listAudioInputs;
    void load().then((list) => {
      if (active) setDevices(list);
    });
    return () => {
      active = false;
    };
  }, [enumerateDevices]);

  // The hook requires an audio bridge; when missing (non-Electron render) we
  // pass a no-op so the component still renders its disabled controls.
  const capture = useCapture({
    audio: audio ?? noopAudio,
    meetingId: audio ? meetingId : null,
    micDeviceId,
    createController,
  });

  const { statuses, screenPermission, start, stop } = capture;

  const toggle = useCallback(
    (source: AudioSource) => {
      const state = statuses[source].state;
      if (state === "capturing" || state === "starting") void stop(source);
      else void start(source);
    },
    [statuses, start, stop],
  );

  const disabled = !meetingId || !audio;
  const systemBlocked = screenPermission === "restricted";

  return (
    <section
      className="panel"
      aria-labelledby="capture-title"
      data-testid="capture-panel"
    >
      <h2 className="panel__title" id="capture-title">
        Capture
      </h2>
      <p className="panel__subtitle">
        {disabled
          ? "Start or open a meeting to capture audio."
          : "Mic (You) and system (They) are captured as two independent 16 kHz streams."}
      </p>

      <CaptureScreenPermission status={screenPermission} />

      <div className="capture__row">
        <label className="capture__field">
          <span className="capture__field-label">Microphone</span>
          <select
            className="capture__select"
            data-testid="mic-device-select"
            value={micDeviceId ?? ""}
            disabled={disabled || statuses.mic.state === "capturing"}
            onChange={(e) => setMicDeviceId(e.target.value || undefined)}
          >
            <option value="">System default</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="capture__sources">
        {(["mic", "system"] as const).map((source) => {
          const st = statuses[source];
          const isOn = st.state === "capturing" || st.state === "starting";
          const srcDisabled = disabled || (source === "system" && systemBlocked);
          return (
            <div className="capture__source" key={source}>
              <button
                type="button"
                className={`btn ${isOn ? "btn--stop" : ""}`}
                data-testid={`capture-toggle-${source}`}
                disabled={srcDisabled || st.state === "stopping"}
                aria-pressed={isOn}
                onClick={() => toggle(source)}
              >
                {st.state === "starting"
                  ? "Starting…"
                  : st.state === "stopping"
                    ? "Stopping…"
                    : isOn
                      ? `Stop ${SOURCE_BUTTON_LABEL[source]}`
                      : `Start ${SOURCE_BUTTON_LABEL[source]}`}
              </button>
              <CaptureLevelMeter source={source} level={st.level} active={isOn} />
              {st.state === "error" && (
                <p
                  className="capture__error"
                  data-testid={`capture-error-${source}`}
                  role="alert"
                >
                  {st.error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A no-op audio bridge for non-Electron renders so the panel still mounts. */
const noopAudio = {
  startCapture: async () => ({
    ok: false,
    code: "no_bridge",
    message: "audio bridge unavailable",
  }),
  stopCapture: async () => ({ ok: true }),
  sendFrame: () => {},
  getScreenPermission: async () => "not-applicable" as const,
  onScreenPermission: () => () => {},
};
