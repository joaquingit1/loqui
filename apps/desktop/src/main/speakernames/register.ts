/**
 * PRD-6 — speaker-names IPC bridge + post-diarization correlation hook (main side).
 *
 * Two pieces, both wired by Foundation's main/index.ts after the WS server +
 * postProcess pipeline exist:
 *
 *   - {@link registerSpeakerNamesIpc}: binds the `window.loqui.speakerNames`
 *     surface (status invoke) and pushes status changes to the renderer. Mirrors
 *     registerMcpIpc / registerCalendarIpc — returns a disposer.
 *
 *   - {@link runSpeakerNamesCorrelation}: the post-diarization hook. After
 *     `postProcessDone` for a meeting, main calls this to drain that meeting's
 *     buffered activity, run the PURE {@link import("./correlate.js").correlateSpeakerNames}
 *     over the freshly-written diarized transcript, and apply the result via the
 *     applier (REUSING the PRD-5 diarized-rewrite path; MANUAL renames win). Plus
 *     {@link subscribeSpeakerNamesCorrelation}, which subscribes that hook to the
 *     supervisor's `postProcessDone` notifications (gated to Google-Meet meetings).
 *
 * #1 INVARIANT — GRACEFUL DEGRADATION: every path here is best-effort. The status
 * invoke never throws; the correlation hook swallows + logs ANY failure (no
 * activity, parse error, applier error) and returns null so the meeting still
 * completes with generic `Speaker N` labels. Nothing here touches the live
 * transcript.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  POSTPROCESS_DONE_EVENT,
  postProcessDoneSchema,
  type Meeting,
  type SpeakerCorrelationParams,
  type SpeakerCorrelationResult,
  type SpeakerNamesStatus,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type {
  RegisterSpeakerNamesIpc,
  RunSpeakerNamesCorrelation,
  SpeakerNamesCorrelationHookDeps,
} from "./types.js";

/**
 * Register the speaker-names status invoke + push the status to the renderer on
 * change. Returns a disposer that removes the handler and unsubscribes the push.
 * `getWindow` resolves the live window at emit time so the push survives window
 * recreation.
 */
export const registerSpeakerNamesIpc: RegisterSpeakerNamesIpc = (deps) => {
  const { server, getWindow } = deps;

  ipcMain.handle(IPC.speakerNamesStatus, (_e: IpcMainInvokeEvent): SpeakerNamesStatus => {
    return server.getStatus();
  });

  const unsubscribe = server.onStatusChange((status: SpeakerNamesStatus) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.speakerNamesStatusChanged, status);
    }
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC.speakerNamesStatus);
  };
};

/**
 * The post-diarization correlation hook. Drains the WS server's buffered
 * activity for `meetingId`, runs the PURE engine over the freshly-written
 * diarized transcript, and applies the result. TOTAL + best-effort: ANY error is
 * swallowed + logged so the meeting still completes with generic labels.
 *
 * `params` lets the caller anchor the engine's clock to the meeting start
 * (`meetingStartEpochMs`) — main passes the meeting's `startedAt` epoch ms.
 * Returns the applied result, or null when nothing was applied.
 */
export function runSpeakerNamesCorrelation(
  deps: SpeakerNamesCorrelationHookDeps,
  meetingId: string,
  params?: SpeakerCorrelationParams,
): SpeakerCorrelationResult | null {
  const { server, store, correlate, apply } = deps;
  try {
    const buffered = server.drainActivity(meetingId);
    // No extension / no activity captured => nothing to do (keep generic labels).
    if (!buffered || buffered.events.length === 0) return null;

    const diarized = store.getDiarizedTranscript(meetingId);
    if (!diarized) return null; // not diarized (degraded) => keep generic labels.

    const result = correlate(diarized, buffered.events, params);
    // Apply (REUSES the PRD-5 rewrite path; manual renames win; a no-op result
    // leaves transcript.live.md / transcript.jsonl byte-identical).
    apply(store, result);
    return result;
  } catch (err) {
    // Best-effort: a correlation/apply failure must never break the meeting.
    console.error("[loqui] speakernames correlation failed:", err);
    return null;
  }
}

// Assert the (params-extended) implementation satisfies the Foundation contract
// signature (which takes deps + meetingId only — the extra param is optional).
const _runSpeakerNamesCorrelationContract: RunSpeakerNamesCorrelation =
  runSpeakerNamesCorrelation;
void _runSpeakerNamesCorrelationContract;

/**
 * Subscribe the correlation hook to the supervisor's `postProcessDone` WS
 * notifications. For each completed meeting that is a Google-Meet meeting, run
 * {@link runSpeakerNamesCorrelation} against the just-written diarized output,
 * anchoring the engine clock to the meeting's `startedAt`. Returns an
 * unsubscribe fn. Reuses the exact PRD-5 notification fan-out (no new transport).
 *
 * Gating to Google Meet keeps the feature scoped (PRD-6 only attributes Meet);
 * non-Meet meetings simply keep their generic labels. A meeting whose record is
 * unreadable is skipped (best-effort).
 */
export function subscribeSpeakerNamesCorrelation(deps: {
  supervisor: { onNotification(cb: (event: string, data: unknown) => void): () => void };
  hook: SpeakerNamesCorrelationHookDeps;
  /** Read the meeting record (for platform gating + startedAt anchoring). */
  getMeeting: (id: string) => Meeting | null;
}): () => void {
  const { supervisor, hook, getMeeting } = deps;
  return supervisor.onNotification((event: string, data: unknown) => {
    if (event !== POSTPROCESS_DONE_EVENT) return;
    const parsed = postProcessDoneSchema.safeParse(data);
    if (!parsed.success) return;
    const meetingId = parsed.data.meetingId;
    try {
      const meeting = getMeeting(meetingId);
      // PRD-6 attributes Google Meet only; other platforms keep generic labels.
      if (!meeting || meeting.platform !== "google-meet") return;
      const startedAtMs = meeting.startedAt ? Date.parse(meeting.startedAt) : NaN;
      const params: SpeakerCorrelationParams = {
        meetingStartEpochMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
      };
      runSpeakerNamesCorrelation(hook, meetingId, params);
    } catch (err) {
      // Never let the correlation pass break the postProcess fan-out.
      console.error("[loqui] speakernames postProcessDone hook failed:", err);
    }
  });
}
