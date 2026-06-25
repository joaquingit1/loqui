/**
 * React hook that drives the meeting lifecycle (PRD-3) from the typed preload
 * bridge.
 *
 * Responsibilities:
 *   - `start()`  → `window.loqui.library.startMeeting()` (mints + records the
 *                  meeting), then kicks off PRD-1 capture for the new meetingId
 *                  via the injected `capture` hooks.
 *   - `stop()`   → tears capture down first (flush WAVs), then
 *                  `window.loqui.library.stopMeeting()` to transition the meeting
 *                  to processing/done.
 *   - subscribes to `window.loqui.library.onMeetingStatus` so server-driven
 *                  transitions (recording → processing → done/error) update the
 *                  phase without re-polling.
 *
 * All side-effecting surfaces are injectable so the hook is unit-testable with a
 * fake bridge + fake capture (no Electron, no devices, no network). Errors from
 * any step are caught and surfaced as the `error` phase — they never throw out
 * of the click handler.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AudioSource, Meeting, StartMeetingParams } from "@loqui/shared";
import type { LoquiApi } from "../../preload/index.js";
import {
  applyStatusEvent,
  canStart,
  canStop,
  initialMeetingState,
  type MeetingControllerState,
} from "./model.js";

/** The lifecycle subset of the library bridge this hook needs. */
export type MeetingLifecycleApi = Pick<
  LoquiApi["library"],
  "startMeeting" | "stopMeeting" | "onMeetingStatus"
>;

/**
 * The capture surface the controller drives on start/stop. Deliberately minimal
 * (just the two imperative calls) so the controller stays decoupled from the
 * PRD-1 `useCapture` hook; the {@link MeetingControls} component adapts the hook
 * to this shape. `startAll(meetingId)` begins both mic + system streams for the
 * freshly-created meeting; `stopAll()` tears every source down.
 */
export interface MeetingCaptureControl {
  /**
   * Begin capture for the freshly-created meeting. `sources` defaults to both
   * mic + system; PRD-12 voice memos pass `["mic"]` so no system stream opens.
   */
  startAll(meetingId: string, sources?: readonly AudioSource[]): Promise<void> | void;
  stopAll(): Promise<void> | void;
}

export interface UseMeetingControllerOptions {
  /**
   * The lifecycle bridge. Defaults to `window.loqui.library` (absent in
   * non-Electron renders, in which case start/stop fail gracefully into the
   * error phase). Tests inject a fake.
   */
  api?: MeetingLifecycleApi;
  /** Capture controls invoked on start/stop. Optional (no-op if omitted). */
  capture?: MeetingCaptureControl;
  /** Default params merged into `start()` (e.g. a detected platform/title). */
  defaultParams?: StartMeetingParams;
}

export interface UseMeetingControllerResult extends MeetingControllerState {
  /** True while either Start or Stop is mid-flight (button should disable). */
  busy: boolean;
  /** Whether Start is currently a valid action. */
  canStart: boolean;
  /** Whether Stop is currently a valid action. */
  canStop: boolean;
  /** Create + start a meeting and begin capture. Never throws. */
  start(params?: StartMeetingParams): Promise<void>;
  /** Stop capture + the meeting. Never throws. */
  stop(): Promise<void>;
  /** Dismiss a finished/errored meeting back to idle (clears the surfaced one). */
  dismiss(): void;
}

type Action =
  | { type: "starting" }
  | { type: "started"; meeting: Meeting }
  | { type: "stopping" }
  | { type: "stopped"; meeting: Meeting }
  | { type: "status"; meeting: Meeting }
  | { type: "error"; message: string }
  | { type: "dismiss" };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Something went wrong.";
}

function reducer(
  state: MeetingControllerState,
  action: Action,
): MeetingControllerState {
  switch (action.type) {
    case "starting":
      return { phase: "starting", meeting: null, error: null };
    case "started":
      // Trust the server status (normally "recording"); fall through the model.
      return applyStatusEvent({ ...state, meeting: action.meeting }, action.meeting);
    case "stopping":
      return { ...state, phase: "stopping", error: null };
    case "stopped":
      return applyStatusEvent({ ...state, phase: "stopping" }, action.meeting);
    case "status":
      return applyStatusEvent(state, action.meeting);
    case "error":
      return { ...state, phase: "error", error: action.message };
    case "dismiss":
      return initialMeetingState;
    default:
      return state;
  }
}

export function useMeetingController(
  options: UseMeetingControllerOptions = {},
): UseMeetingControllerResult {
  const { capture, defaultParams } = options;
  const [state, dispatch] = useReducer(reducer, initialMeetingState);

  // Resolve the bridge lazily so SSR/plain renders (no window.loqui) don't crash.
  const resolveApi = useCallback((): MeetingLifecycleApi | undefined => {
    return (
      options.api ??
      (typeof window !== "undefined" ? window.loqui?.library : undefined)
    );
  }, [options.api]);

  // Keep the id of the meeting we're tracking so the status subscription (set up
  // once) can read the latest without re-subscribing.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = state.meeting?.id ?? null;

  // Guard against overlapping start/stop calls (double-click) and against state
  // updates landing after unmount.
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Subscribe once to server-driven status pushes. The reducer ignores events
  // for meetings other than the one we're tracking.
  useEffect(() => {
    const api = resolveApi();
    if (!api?.onMeetingStatus) return;
    const unsubscribe = api.onMeetingStatus((meeting: Meeting) => {
      if (!mountedRef.current) return;
      dispatch({ type: "status", meeting });
    });
    return unsubscribe;
  }, [resolveApi]);

  const start = useCallback(
    async (params?: StartMeetingParams): Promise<void> => {
      if (inFlightRef.current) return;
      const api = resolveApi();
      if (!api?.startMeeting) {
        dispatch({ type: "error", message: "Meeting bridge unavailable." });
        return;
      }
      inFlightRef.current = true;
      dispatch({ type: "starting" });
      try {
        const merged = { ...defaultParams, ...params };
        const meeting = await api.startMeeting(merged);
        if (!mountedRef.current) return;
        dispatch({ type: "started", meeting });
        // Kick off capture for the freshly-created meeting. A capture failure is
        // surfaced per-source by the capture UI; we still consider the meeting
        // started (audio may be partially available), so we don't flip to error
        // here — startAll swallows/own-reports its own errors. PRD-12: a voice
        // memo is MIC-ONLY — never open the system stream.
        const sources: readonly AudioSource[] =
          merged.kind === "voice-memo" ? ["mic"] : ["mic", "system"];
        try {
          await capture?.startAll(meeting.id, sources);
        } catch (err) {
          // Non-fatal: the meeting is recording; capture surfaces its own error.
          if (mountedRef.current) {
            dispatch({ type: "error", message: errorMessage(err) });
          }
        }
      } catch (err) {
        if (mountedRef.current) dispatch({ type: "error", message: errorMessage(err) });
      } finally {
        inFlightRef.current = false;
      }
    },
    [resolveApi, capture, defaultParams],
  );

  const stop = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) return;
    const id = activeIdRef.current;
    const api = resolveApi();
    if (!id || !api?.stopMeeting) {
      dispatch({ type: "error", message: "No active meeting to stop." });
      return;
    }
    inFlightRef.current = true;
    dispatch({ type: "stopping" });
    try {
      // Flush + finalize the WAVs before telling the backend the meeting is done.
      await capture?.stopAll();
      const meeting = await api.stopMeeting({ id });
      if (!mountedRef.current) return;
      dispatch({ type: "stopped", meeting });
    } catch (err) {
      if (mountedRef.current) dispatch({ type: "error", message: errorMessage(err) });
    } finally {
      inFlightRef.current = false;
    }
  }, [resolveApi, capture]);

  const dismiss = useCallback((): void => {
    dispatch({ type: "dismiss" });
  }, []);

  const busy = state.phase === "starting" || state.phase === "stopping";

  return {
    ...state,
    busy,
    canStart: canStart(state.phase) && !busy,
    canStop: canStop(state.phase) && !busy,
    start,
    stop,
    dismiss,
  };
}
