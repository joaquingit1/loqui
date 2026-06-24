/**
 * Post-processing IPC + WS bridge registration (PRD-5, main side).
 *
 * The single place main binds the `window.loqui.postprocess` surface (defined in
 * src/preload/index.ts) to the sidecar supervisor, the meeting store, the HF
 * keystore, and the post-processing pipeline.
 *
 * Channels (from src/shared/ipc.ts):
 *   - postProcessJob (push)        : relay sidecar `jobUpdate` (diarization/summary) to the renderer.
 *   - getSummary (invoke)          : READ-ONLY summary.json via the store reader.
 *   - getDiarizedTranscript (invoke): READ-ONLY transcript.diarized.json via the store reader.
 *   - renameSpeaker (invoke)       : deterministic main-driven rewrite of the diarized
 *                                    files + meta.participants + re-index. NOT an AI write.
 *   - regenerateSummary (invoke)   : summary-only postProcess run via the pipeline.
 *   - setHfToken / getHfTokenStatus: HF token in the OS keychain via safeStorage.
 *
 * CROSS-CUTTING INVARIANT (the AI never edits the transcript): NOTHING here
 * writes transcript.live.md / transcript.jsonl / meta.json's transcript. The
 * rename rewrites ONLY the derived diarized files (via ./writers.ts) + the
 * meta.participants display name + the FTS summary column. There is no
 * TranscriptWriter import and no live-transcript path in this module.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  EVENT,
  getDiarizedTranscriptParamsSchema,
  getSummaryParamsSchema,
  jobEventSchema,
  regenerateSummaryParamsSchema,
  renameSpeakerParamsSchema,
  setHfTokenParamsSchema,
  type DiarizedSegment,
  type DiarizedTranscript,
  type HfTokenStatus,
  type Summary,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { MeetingStore } from "../store/index.js";
import type { HfKeystore } from "./hf-keystore.js";
import type { PostProcessPipeline } from "./pipeline.js";
import { buildIndexText } from "./render.js";
import { writeDiarizedTranscript } from "./writers.js";

export interface PostProcessIpcDeps {
  /** READ-ONLY summary/diarized accessors + meta update + index. */
  store: Pick<
    MeetingStore,
    "getMeeting" | "updateMeeting" | "getSummary" | "getDiarizedTranscript" | "upsertSearchText"
  >;
  /** HF token storage (set/get status; never returns the token). */
  hfKeystore: Pick<HfKeystore, "setHfToken" | "getHfTokenStatus">;
  /** The post-processing pipeline (backs the regenerate-summary IPC). */
  pipeline: Pick<PostProcessPipeline, "requestSummaryRegeneration">;
}

/**
 * Register the post-processing invoke handlers. Returns a disposer.
 *
 * Every payload is re-validated here (defense in depth — the renderer is
 * untrusted) before it reaches the store/keystore/pipeline.
 */
export function registerPostProcessIpc(deps: PostProcessIpcDeps): () => void {
  const { store, hfKeystore, pipeline } = deps;

  ipcMain.handle(
    IPC.getSummary,
    (_e: IpcMainInvokeEvent, params: unknown): Summary | null => {
      const { meetingId } = getSummaryParamsSchema.parse(params);
      return store.getSummary(meetingId);
    },
  );

  ipcMain.handle(
    IPC.getDiarizedTranscript,
    (_e: IpcMainInvokeEvent, params: unknown): DiarizedTranscript | null => {
      const { meetingId } = getDiarizedTranscriptParamsSchema.parse(params);
      return store.getDiarizedTranscript(meetingId);
    },
  );

  ipcMain.handle(
    IPC.renameSpeaker,
    (_e: IpcMainInvokeEvent, params: unknown): DiarizedTranscript => {
      const parsed = renameSpeakerParamsSchema.parse(params);
      return renameSpeaker(store, parsed.meetingId, parsed.speaker, parsed.displayName);
    },
  );

  ipcMain.handle(
    IPC.regenerateSummary,
    (_e: IpcMainInvokeEvent, params: unknown): void => {
      const { meetingId } = regenerateSummaryParamsSchema.parse(params);
      pipeline.requestSummaryRegeneration(meetingId);
    },
  );

  ipcMain.handle(
    IPC.setHfToken,
    (_e: IpcMainInvokeEvent, params: unknown): HfTokenStatus => {
      return hfKeystore.setHfToken(setHfTokenParamsSchema.parse(params));
    },
  );

  ipcMain.handle(IPC.getHfTokenStatus, (): HfTokenStatus => {
    return hfKeystore.getHfTokenStatus();
  });

  return () => {
    ipcMain.removeHandler(IPC.getSummary);
    ipcMain.removeHandler(IPC.getDiarizedTranscript);
    ipcMain.removeHandler(IPC.renameSpeaker);
    ipcMain.removeHandler(IPC.regenerateSummary);
    ipcMain.removeHandler(IPC.setHfToken);
    ipcMain.removeHandler(IPC.getHfTokenStatus);
  };
}

/**
 * Deterministically rename a speaker for one meeting (main-driven, NOT an AI
 * write). Reads the diarized transcript via the store reader, sets/clears the
 * `displayName` on every segment whose stable `speaker` label matches, rewrites
 * BOTH diarized files (so the `.md` re-renders with the friendly name), persists
 * the rename into meta.participants (the matching `speakerLabel`'s `name`), and
 * re-indexes the diarized + summary searchable text. Returns the updated diarized
 * transcript. Never touches transcript.live.md / transcript.jsonl.
 *
 * An empty `displayName` CLEARS the rename back to the stable label (`displayName`
 * -> null; the participant `name` reverts to the label).
 */
function renameSpeaker(
  store: PostProcessIpcDeps["store"],
  meetingId: string,
  speaker: string,
  displayName: string,
): DiarizedTranscript {
  const diarized = store.getDiarizedTranscript(meetingId);
  if (!diarized) {
    throw new Error(`postprocess: cannot rename speaker — meeting ${meetingId} is not diarized`);
  }

  const name = displayName.trim();
  const nextDisplay = name === "" ? null : name;

  const segments: DiarizedSegment[] = diarized.segments.map((seg) =>
    seg.speaker === speaker ? { ...seg, displayName: nextDisplay } : seg,
  );
  const updated: DiarizedTranscript = { ...diarized, segments };

  // Rewrite the derived diarized files (json + re-rendered md). Atomic.
  writeDiarizedTranscript(updated);

  // Persist the rename into meta.participants: the participant mapped to this
  // speaker label gets the friendly name (or reverts to the label when cleared).
  const current = store.getMeeting(meetingId);
  if (current) {
    let found = false;
    const participants = current.participants.map((p) => {
      if (p.speakerLabel === speaker) {
        found = true;
        return { ...p, name: nextDisplay ?? speaker };
      }
      return p;
    });
    if (!found) {
      participants.push({ id: speaker, name: nextDisplay ?? speaker, speakerLabel: speaker });
    }
    store.updateMeeting(meetingId, { participants });
  }

  // Re-index the diarized + summary searchable text so search reflects the
  // friendly name (READ-ONLY over the live transcript: only the FTS summary col).
  const summary: Summary | null = store.getSummary(meetingId);
  store.upsertSearchText({ meetingId, summary: buildIndexText(updated, summary) });

  return updated;
}

/**
 * Relay the sidecar's `jobUpdate` WS notifications (kind "diarization" |
 * "summary") to the renderer on {@link IPC.postProcessJob} (PRD-5). Subscribes to
 * the supervisor's notification fan-out, filters to {@link EVENT.jobUpdate},
 * validates + normalizes the payload ({@link jobEventSchema}; a malformed update
 * is dropped, never forwarded), and pushes the parsed {@link
 * import("@loqui/shared").JobEvent} to the live window. Returns an unsubscribe
 * fn. `getWindow` resolves the live window at emit time so the push survives
 * window recreation. Reuses the exact PRD-2/PRD-4 notification wire pattern — no
 * new transport.
 */
export function forwardJobUpdates(
  supervisor: { onNotification(cb: (event: string, data: unknown) => void): () => void },
  getWindow: () => BrowserWindow | null,
): () => void {
  return supervisor.onNotification((event: string, data: unknown) => {
    if (event !== EVENT.jobUpdate) return;
    const parsed = jobEventSchema.safeParse(data);
    if (!parsed.success) return; // drop malformed updates, never forward.
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.postProcessJob, parsed.data);
    }
  });
}
