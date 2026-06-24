/**
 * MeetingControls — the in-meeting control surface (PRD-3).
 *
 * Composes the whole live-meeting experience around {@link useMeetingController}:
 *   - a single Start ⇄ Stop button that creates+records a meeting (and kicks off
 *     dual-stream capture) on Start, and stops capture + finalizes the meeting on
 *     Stop;
 *   - a {@link RecordingStatus} pill with a live elapsed-time clock;
 *   - per-source level meters while recording (mic = You, system = They);
 *   - the PRD-2 {@link LiveTranscript}, scoped to the active meeting so a previous
 *     meeting's segments can't bleed in;
 *   - graceful surfacing of capture/permission failures and a "sidecar
 *     disconnected" banner (the lifecycle calls are disabled while the sidecar is
 *     not connected, since starting a meeting depends on the transcription path).
 *
 * It talks ONLY to the typed `window.loqui` bridge (injectable for tests), never
 * to IPC channels or Node globals.
 */
import { useCallback, useMemo, type JSX } from "react";
import type { AudioSource, StartMeetingParams } from "@loqui/shared";
import type { LoquiApi, SidecarStatus } from "../../preload/index.js";
import { LiveTranscript } from "./LiveTranscript.js";
import { ChatPanel } from "./ChatPanel.js";
import { ProcessingStatus } from "./ProcessingStatus.js";
import { CaptureLevelMeter } from "./CaptureLevelMeter.js";
import { RecordingStatus } from "./RecordingStatus.js";
import { useJobProgress, allJobsTerminal } from "../summary/index.js";
import {
  isRecordingPhase,
  useElapsed,
  useMeetingCapture,
  useMeetingController,
  type MeetingCaptureControl,
} from "../meeting/index.js";
import type { CaptureController, CaptureControllerDeps } from "../capture/index.js";
import "../meeting/meeting.css";

export interface MeetingControlsProps {
  /** Injectable bridge; defaults to window.loqui. */
  api?: Pick<LoquiApi, "library" | "audio" | "onTranscriptSegment">;
  /**
   * Current sidecar connection status. When not "connected", Start is disabled
   * with an explanatory note (recording depends on the transcription path).
   * Defaults to "connected" so the control is usable in isolation/tests.
   */
  sidecarStatus?: SidecarStatus;
  /** Default start params (e.g. a detected platform). */
  defaultParams?: StartMeetingParams;
  /** Mic device id from a picker (undefined = system default). */
  micDeviceId?: string;
  /** Inject a capture-controller factory for tests (defaults to the real one). */
  createCaptureController?: (deps: CaptureControllerDeps) => CaptureController;
}

const SOURCES: readonly AudioSource[] = ["mic", "system"];

/** A no-op audio bridge so the control still mounts in a non-Electron render. */
const NOOP_AUDIO: LoquiApi["audio"] = {
  startCapture: async () => ({ ok: false, code: "no_bridge", message: "no audio bridge" }),
  stopCapture: async () => ({ ok: true }),
  sendFrame: () => {},
  getScreenPermission: async () => "not-applicable" as const,
  onScreenPermission: () => () => {},
};

export function MeetingControls({
  api,
  sidecarStatus = "connected",
  defaultParams,
  micDeviceId,
  createCaptureController,
}: MeetingControlsProps): JSX.Element {
  const loqui = api ?? (typeof window !== "undefined" ? window.loqui : undefined);
  const audio = loqui?.audio ?? NOOP_AUDIO;

  // Capture adapter — drives both streams imperatively the moment the meeting id
  // is known (see useMeetingCapture).
  const capture = useMeetingCapture({
    audio,
    micDeviceId,
    createController: createCaptureController,
  });

  // Adapt the capture adapter to the controller's MeetingCaptureControl shape.
  // Stable across renders so the controller's start/stop callbacks don't churn.
  const captureControl = useMemo<MeetingCaptureControl>(
    () => ({
      startAll: (meetingId) => capture.startAll(meetingId),
      stopAll: () => capture.stopAll(),
    }),
    [capture.startAll, capture.stopAll],
  );

  const controller = useMeetingController({
    api: loqui?.library,
    capture: captureControl,
    defaultParams,
  });

  const { phase, meeting, error } = controller;
  const recording = isRecordingPhase(phase);

  // PRD-5 post-processing progress: once the meeting stops, main hands the WAVs
  // to the sidecar which diarizes + summarizes as background jobs. Surface that
  // progress during the "processing" phase so the user sees the pipeline run.
  const { jobs } = useJobProgress();

  const elapsed = useElapsed({
    startedAt: meeting?.startedAt ?? null,
    endedAt: meeting?.endedAt ?? null,
    running: recording,
  });

  const sidecarReady = sidecarStatus === "connected";
  const startDisabled = !controller.canStart || !sidecarReady;

  const onToggle = useCallback(() => {
    if (controller.canStop) void controller.stop();
    else if (controller.canStart) void controller.start();
  }, [controller]);

  const buttonLabel = recording || phase === "stopping" ? "Stop meeting" : "Start meeting";
  const isStopAction = controller.canStop || phase === "stopping";

  return (
    <section
      className="panel meeting"
      aria-labelledby="meeting-title"
      data-testid="meeting-controls"
      data-phase={phase}
    >
      <div className="meeting__bar">
        <div>
          <h2 className="panel__title" id="meeting-title">
            Meeting
          </h2>
          <p className="panel__subtitle">
            Start a meeting to record both sides and watch the transcript build live.
          </p>
        </div>
        <button
          type="button"
          className={`btn ${isStopAction ? "btn--stop" : ""}`}
          data-testid="meeting-toggle"
          aria-pressed={recording}
          disabled={isStopAction ? controller.busy : startDisabled}
          onClick={onToggle}
        >
          {controller.busy
            ? phase === "starting"
              ? "Starting…"
              : "Stopping…"
            : buttonLabel}
        </button>
      </div>

      <RecordingStatus phase={phase} elapsedSeconds={elapsed} error={error} />

      {!sidecarReady && controller.canStart && (
        <p className="meeting__note" data-testid="meeting-sidecar-note" role="status">
          The transcription engine is {sidecarStatus}. Recording is unavailable until it
          reconnects.
        </p>
      )}

      {(recording || phase === "stopping") && (
        <div className="meeting__meters" data-testid="meeting-meters">
          {SOURCES.map((source) => {
            const st = capture.statuses[source];
            const active = st.state === "capturing" || st.state === "starting";
            return (
              <div className="meeting__meter" key={source}>
                <CaptureLevelMeter source={source} level={st.level} active={active} />
                {st.state === "error" && (
                  <p
                    className="meeting__capture-error"
                    data-testid={`meeting-capture-error-${source}`}
                    role="alert"
                  >
                    {st.error ?? "Capture failed."}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(recording || phase === "stopping" || phase === "processing") && (
        <LiveTranscript api={loqui} meetingId={meeting?.id ?? null} />
      )}

      {(recording || phase === "stopping" || phase === "processing") && meeting?.id && (
        // In-call AI chat, grounded READ-ONLY in this meeting's live transcript
        // (PRD-4). ChatPanel talks to window.loqui.chat itself; it never writes
        // the transcript. Scoped to the active meeting id so history resets per
        // meeting.
        <ChatPanel meetingId={meeting.id} />
      )}

      {phase === "processing" && (
        // Post-meeting diarization + summary progress (PRD-5). The pipeline runs
        // in the sidecar; this only reflects its JobUpdate progress.
        <ProcessingStatus jobs={jobs} active={!allJobsTerminal(jobs)} />
      )}

      {phase === "done" && meeting && (
        <div className="meeting__done" data-testid="meeting-done">
          <p className="meeting__done-text">
            Saved “{meeting.title || "Untitled meeting"}”. Find it in your library.
          </p>
          <button
            type="button"
            className="btn"
            data-testid="meeting-dismiss"
            onClick={controller.dismiss}
          >
            New meeting
          </button>
        </div>
      )}

      {phase === "error" && (
        <button
          type="button"
          className="btn"
          data-testid="meeting-retry"
          onClick={controller.dismiss}
        >
          Dismiss
        </button>
      )}
    </section>
  );
}
