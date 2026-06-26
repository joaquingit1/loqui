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
import { MeetingDoc } from "./MeetingDoc.js";
import { RecordingStatus } from "./RecordingStatus.js";
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
   * A pending start request from the shell (Home "Start a meeting", a calendar
   * "join & record", or ⌘N). When non-null and a start is possible, the
   * controller performs the ATOMIC startMeeting + capture with these params — so
   * the live transcript's meetingId is always the id actually being transcribed
   * (one owner of start+capture, no divergence). The shell clears it via
   * {@link onPendingStartConsumed} once consumed.
   */
  pendingStart?: StartMeetingParams | null;
  /** Called once the pending start has been initiated (the shell clears it). */
  onPendingStartConsumed?: () => void;
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
  pendingStart = null,
  onPendingStartConsumed,
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

  // Start a pending request from the shell (Home "Start a meeting" / "join &
  // record" / ⌘N) through the controller — the ONE owner of startMeeting +
  // capture. Fires once when a start is possible (canStart + a ready sidecar);
  // if the sidecar isn't connected yet, this effect re-runs when it connects.
  // The ref guards a double-start before the shell clears the request. Works on
  // a fresh mount (unlike a counter, whose ref would equal its initial value).
  const pendingStartedRef = useRef(false);
  useEffect(() => {
    if (pendingStart == null) {
      pendingStartedRef.current = false;
      return;
    }
    if (pendingStartedRef.current) return;
    if (!controller.canStart || sidecarStatus !== "connected") return;
    pendingStartedRef.current = true;
    void controller.start(pendingStart);
    onPendingStartConsumed?.();
  }, [pendingStart, controller, sidecarStatus, onPendingStartConsumed]);

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
    // Mic is the REQUIRED source, so a mic error is a real alert (and should be
    // rare). The system (loopback) source is OPTIONAL: on macOS it can't start
    // without Screen Recording, which is expected + NON-FATAL (the mic still
    // records) — surface it as a quiet one-line note, never a persistent alarm.
    const micErr =
      capture.statuses.mic.state === "error" ? capture.statuses.mic.error : null;
    const systemErr =
      capture.statuses.system.state === "error" ? capture.statuses.system.error : null;
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

        {micErr && (
          <p
            className="meeting__note meeting__note--alert"
            data-testid="meeting-capture-error-mic"
            role="alert"
          >
            {micErr}
          </p>
        )}
        {!micErr && systemErr && (
          <p
            className="meeting__note"
            data-testid="meeting-capture-error-system"
            role="status"
          >
            {systemErr}
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

  // ---- PROCESSING / DONE: the meeting stays on THIS page and becomes the
  // finished document (no library round-trip). MeetingDoc shows the summary
  // streaming in live while processing, then the finished summary-centric doc.
  if ((phase === "processing" || phase === "done") && meeting?.id) {
    return (
      <section
        className={`meeting meeting--${phase}`}
        aria-labelledby="meeting-title"
        data-testid="meeting-controls"
        data-phase={phase}
      >
        <h2 className="visually-hidden" id="meeting-title">
          {phase === "processing" ? "Processing" : "Meeting"}
        </h2>
        <div className="meeting__doc-bar">
          <button
            type="button"
            className="meeting__ghost"
            data-testid="meeting-new"
            onClick={onStart}
            disabled={startDisabled}
          >
            <Icon name="mic" size={16} aria-hidden="true" />
            New meeting
          </button>
        </div>
        <MeetingDoc meeting={meeting} api={loqui?.library} />
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

        {phase === "error" ? (
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
