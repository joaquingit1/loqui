/**
 * MeetingControls — the live in-meeting surface (PRD-3, DESIGN-SYSTEM §9.10).
 *
 * This is the signature in-meeting moment: watch the transcript flow by in real
 * time, and ask the AI questions live. It is deliberately calm and editorial —
 * not a busy dashboard.
 *
 * It composes the whole live experience around {@link useMeetingController}:
 *   - an editorial IDLE state (a serif line + a single primary Start and a quiet
 *     Voice-memo, plus a note about what gets captured);
 *   - a restrained RECORDING state: a small pulsing recording indicator + a
 *     `--text-mono` elapsed clock and quiet line-icon controls (per-source mute
 *     toggles + Stop), the flowing {@link LiveTranscript} as the main column, and
 *     the in-call {@link ChatPanel} docked at the bottom to ask questions live;
 *   - graceful surfacing of capture/permission failures and a "sidecar
 *     disconnected" note (lifecycle calls are disabled while the sidecar is down,
 *     since starting a meeting depends on the transcription path).
 *
 * Status is surfaced by EXCEPTION (§12): the normal recording state is quiet; we
 * only raise a banner-ish note for a capture error or a disconnected sidecar.
 *
 * It talks ONLY to the typed `window.loqui` bridge (injectable for tests), never
 * to IPC channels or Node globals.
 */
import { useCallback, useEffect, useMemo, useRef, type JSX } from "react";
import type { AudioSource, StartMeetingParams } from "@loqui/shared";
import type { LoquiApi, SidecarStatus } from "../../preload/index.js";
import { Icon } from "./Icon.js";
import { Kbd, modKeyLabel } from "../shortcuts/index.js";
import { LiveTranscript } from "./LiveTranscript.js";
import { ChatPanel } from "./ChatPanel.js";
import { ProcessingStatus } from "./ProcessingStatus.js";
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
  /**
   * One-shot ⌘N intent from the shell (PRD-16): when this counter increments and
   * a start is possible, auto-start a meeting. 0 = no pending intent (default).
   */
  autoStartSignal?: number;
}

const SOURCES: readonly AudioSource[] = ["mic", "system"];
const SOURCE_LABEL: Record<AudioSource, string> = { mic: "You", system: "They" };

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
  autoStartSignal = 0,
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
      startAll: (meetingId, sources) => capture.startAll(meetingId, sources),
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
  const live = recording || phase === "stopping";

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

  const onStart = useCallback(() => {
    if (controller.canStart) void controller.start();
  }, [controller]);

  // ⌘N auto-start (PRD-16): when the shell bumps the signal, start a meeting if
  // we can. Skip the initial 0 and only react to a genuine increment so a
  // re-render never re-triggers; gated on canStart + a ready sidecar (same guard
  // as the Start button) so ⌘N is a no-op when starting isn't possible.
  const lastAutoStart = useRef(autoStartSignal);
  useEffect(() => {
    if (autoStartSignal === lastAutoStart.current) return;
    lastAutoStart.current = autoStartSignal;
    if (controller.canStart && sidecarStatus === "connected") void controller.start();
  }, [autoStartSignal, controller, sidecarStatus]);

  const onStop = useCallback(() => {
    if (controller.canStop) void controller.stop();
  }, [controller]);

  // PRD-12 Voice Memo: a MIC-ONLY recording. Reuses the SAME lifecycle +
  // transcription path; we only tag the meeting kind (so the system stream is
  // suppressed and the library shows it distinctly).
  const onVoiceMemo = useCallback(() => {
    if (controller.canStart) void controller.start({ kind: "voice-memo" });
  }, [controller]);

  // ---- LIVE (recording / stopping): the editorial transcript + ask surface ----
  if (live && meeting?.id) {
    const captureError = SOURCES.map((s) => capture.statuses[s]).find(
      (st) => st.state === "error",
    );
    return (
      <section
        className="meeting meeting--live"
        aria-labelledby="meeting-title"
        data-testid="meeting-controls"
        data-phase={phase}
      >
        <h2 className="visually-hidden" id="meeting-title">
          Recording
        </h2>

        <header className="meeting__live-bar">
          <RecordingStatus phase={phase} elapsedSeconds={elapsed} error={error} />

          <div className="meeting__controls" data-testid="meeting-meters">
            {SOURCES.map((source) => {
              const st = capture.statuses[source];
              const muted = st.muted ?? false;
              const active = st.state === "capturing" || st.state === "starting";
              // Voice memos never open the system stream; hide its control.
              if (source === "system" && st.state === "idle" && !active) return null;
              return (
                <SourceControl
                  key={source}
                  source={source}
                  muted={muted}
                  level={active ? st.level : 0}
                  onToggle={() => capture.toggleMute(source)}
                />
              );
            })}
            <button
              type="button"
              className="meeting__icon-btn meeting__icon-btn--stop"
              data-testid="meeting-toggle"
              aria-pressed={recording}
              aria-label="Stop meeting"
              disabled={controller.busy}
              onClick={onStop}
            >
              <Icon name="stop" size={18} />
              <span>{controller.busy ? "Stopping…" : "Stop meeting"}</span>
            </button>
          </div>
        </header>

        {captureError && (
          <p
            className="meeting__note meeting__note--alert"
            data-testid={`meeting-capture-error-${
              capture.statuses.system.state === "error" ? "system" : "mic"
            }`}
            role="alert"
          >
            {captureError.error ?? "Capture failed."}
          </p>
        )}

        <LiveTranscript api={loqui} meetingId={meeting.id} />

        {/* In-call AI chat, grounded READ-ONLY in this meeting's live transcript
            (PRD-4). It talks to window.loqui.chat itself; it never writes the
            transcript. Docked at the bottom so the transcript reads as the main
            column and the ask-composer is always at hand. */}
        <div className="meeting__ask">
          <ChatPanel meetingId={meeting.id} />
        </div>
      </section>
    );
  }

  // ---- PROCESSING: the meeting has stopped; show the pipeline + a quiet recap --
  if (phase === "processing") {
    return (
      <section
        className="meeting meeting--processing"
        aria-labelledby="meeting-title"
        data-testid="meeting-controls"
        data-phase={phase}
      >
        <h2 className="visually-hidden" id="meeting-title">
          Processing
        </h2>
        <RecordingStatus phase={phase} elapsedSeconds={elapsed} error={error} />
        <ProcessingStatus jobs={jobs} active={!allJobsTerminal(jobs)} />
        {meeting?.id && (
          <>
            <LiveTranscript api={loqui} meetingId={meeting.id} />
            <div className="meeting__ask">
              <ChatPanel meetingId={meeting.id} />
            </div>
          </>
        )}
      </section>
    );
  }

  // ---- IDLE / DONE / ERROR: the calm editorial start state ----
  return (
    <section
      className="meeting meeting--idle"
      aria-labelledby="meeting-title"
      data-testid="meeting-controls"
      data-phase={phase}
    >
      <div className="meeting__hero">
        <h2 className="meeting__hero-title" id="meeting-title">
          {phase === "done"
            ? "That’s a wrap"
            : phase === "error"
              ? "Something interrupted the meeting"
              : "Ready when you are"}
        </h2>

        {phase === "done" && meeting ? (
          <p className="meeting__hero-note" data-testid="meeting-done">
            Saved “{meeting.title || "Untitled meeting"}”. Find it in your library.
          </p>
        ) : phase === "error" ? (
          <RecordingStatus phase={phase} elapsedSeconds={elapsed} error={error} />
        ) : (
          <p className="meeting__hero-note">
            Loqui records your mic and the meeting audio as separate streams and
            transcribes them live, right on this Mac.
          </p>
        )}

        <div className="meeting__actions">
          <button
            type="button"
            className="btn meeting__start"
            data-testid="meeting-toggle"
            aria-pressed={false}
            disabled={startDisabled}
            onClick={onStart}
          >
            <Icon name="mic" size={18} />
            {phase === "done" || phase === "error" ? "New meeting" : "Start meeting"}
            {/* ⌘N hint (PRD-16): faint tokenized chip on the primary action. */}
            <Kbd combo={`${modKeyLabel()}N`} className="kbd--on-accent" />
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="meeting-voice-memo"
            disabled={startDisabled}
            onClick={onVoiceMemo}
          >
            Voice memo
          </button>
          {(phase === "done" || phase === "error") && (
            <button
              type="button"
              className="meeting__ghost"
              data-testid={phase === "error" ? "meeting-retry" : "meeting-dismiss"}
              onClick={controller.dismiss}
            >
              Dismiss
            </button>
          )}
        </div>

        {!sidecarReady && controller.canStart && (
          <p className="meeting__note" data-testid="meeting-sidecar-note" role="status">
            The transcription engine is {sidecarStatus}. Recording is unavailable
            until it reconnects.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A quiet per-source control: a line-icon mute toggle with a faint inline VU
 * tick. Subtle by design — status by exception (§12); the meter is a whisper,
 * not a dashboard gauge. Muted shows a red dot (the only place red appears here
 * besides the recording indicator) so a muted side is unmistakable.
 */
function SourceControl({
  source,
  muted,
  level,
  onToggle,
}: {
  source: AudioSource;
  muted: boolean;
  level: number;
  onToggle: () => void;
}): JSX.Element {
  const label = SOURCE_LABEL[source];
  const clamped = Math.max(0, Math.min(1, level));
  const pct = Math.round(Math.sqrt(clamped) * 100);
  return (
    <button
      type="button"
      className={`meeting__icon-btn meeting__src ${muted ? "meeting__src--muted" : ""}`}
      data-testid={`meeting-mute-${source}`}
      data-level={clamped.toFixed(3)}
      aria-pressed={muted}
      aria-label={muted ? `Unmute ${label}` : `Mute ${label}`}
      title={muted ? `Unmute ${label}` : `Mute ${label}`}
      onClick={onToggle}
    >
      <Icon name={muted ? "x-circle" : "mic"} size={18} />
      <span className="meeting__src-label">{label}</span>
      <span className="meeting__vu" aria-hidden="true">
        <span className="meeting__vu-fill" style={{ width: `${muted ? 0 : pct}%` }} />
      </span>
    </button>
  );
}
