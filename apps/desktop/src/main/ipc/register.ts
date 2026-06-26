/**
 * IPC handler registration. The single place the main process binds the
 * `window.loqui` surface (defined in src/preload/index.ts) to the sidecar
 * supervisor and the meeting store.
 *
 * Channel names come from src/shared/ipc.ts (the single source). The renderer
 * never references channels directly — it only sees the typed `window.loqui`
 * API exposed via contextBridge.
 */
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  IMPORT_FILE_EXTENSIONS,
  TRANSCRIPT_SEGMENT_EVENT,
  deleteMeetingParamsSchema,
  getTranscriptParamsSchema,
  importFileParamsSchema,
  listMeetingsQuerySchema,
  renameMeetingParamsSchema,
  startMeetingParamsSchema,
  stopMeetingParamsSchema,
  transcriptSegmentSchema,
  type CreateMeetingInput,
  type DeleteMeetingParams,
  type GetTranscriptParams,
  type Health,
  type ImportFileParams,
  type ListMeetingsQuery,
  type Meeting,
  type RenameMeetingParams,
  type StartMeetingParams,
  type StopMeetingParams,
  type UpdateMeetingInput,
} from "@loqui/shared";
import type { SidecarStatus } from "../../preload/index.js";
import { IPC } from "../../shared/ipc.js";
import type { SidecarSupervisor } from "../sidecar/supervisor.js";
import type { MeetingStore } from "../store/index.js";
import type { MeetingController } from "../transcript/index.js";
import type { ImportPipeline } from "../import/pipeline.js";

export interface IpcDeps {
  supervisor: Pick<SidecarSupervisor, "ping" | "getHealth" | "onStatus">;
  store: MeetingStore;
  /**
   * The meeting lifecycle controller (PRD-3). Backs the `startMeeting` /
   * `stopMeeting` IPC channels and (via {@link pushMeetingStatus}) the
   * `meetingStatus` renderer push.
   */
  controller: MeetingController;
  /**
   * The file-import pipeline (PRD-12). Backs the `importFile` IPC channel:
   * mints a `kind:"import"` meeting and drives the sidecar decode/transcribe/
   * diarize/summarize over an existing media file.
   */
  importPipeline: ImportPipeline;
  /**
   * Resolve the live window (the modal file-picker parent). Optional — when
   * absent the picker opens unparented.
   */
  getWindow?: () => BrowserWindow | null;
}

/**
 * Register every invoke handler against `ipcMain`. Returns a disposer that
 * removes them (used on app teardown / window recreation).
 */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { supervisor, store, controller, importPipeline, getWindow } = deps;

  ipcMain.handle(IPC.ping, async (): Promise<{ ok: boolean; latencyMs: number }> => {
    return supervisor.ping();
  });

  ipcMain.handle(IPC.getSidecarHealth, async (): Promise<Health | null> => {
    return supervisor.getHealth();
  });

  ipcMain.handle(
    IPC.createMeeting,
    (_e: IpcMainInvokeEvent, input?: CreateMeetingInput) => {
      return store.createMeeting(input);
    },
  );

  ipcMain.handle(IPC.listMeetings, () => {
    return store.listMeetings();
  });

  ipcMain.handle(IPC.getMeeting, (_e: IpcMainInvokeEvent, id: string) => {
    return store.getMeeting(id);
  });

  ipcMain.handle(
    IPC.updateMeeting,
    (_e: IpcMainInvokeEvent, payload: { id: string; patch: UpdateMeetingInput }) => {
      return store.updateMeeting(payload.id, payload.patch);
    },
  );

  // --- Meeting lifecycle + Library (PRD-3) ---
  // start/stop go through the lifecycle controller (drives Meeting.status +
  // startedAt/endedAt + the supervisor's active-meeting routing); the read
  // paths go straight to the store. Every payload is re-validated here (defense
  // in depth — the renderer is untrusted) before it reaches the controller/store.

  ipcMain.handle(
    IPC.startMeeting,
    (_e: IpcMainInvokeEvent, params?: StartMeetingParams): Promise<Meeting> => {
      return controller.startMeeting(startMeetingParamsSchema.parse(params ?? {}));
    },
  );

  ipcMain.handle(
    IPC.stopMeeting,
    (_e: IpcMainInvokeEvent, params: StopMeetingParams): Promise<Meeting> => {
      return controller.stopMeeting(stopMeetingParamsSchema.parse(params));
    },
  );

  ipcMain.handle(
    IPC.listMeetingsQuery,
    (_e: IpcMainInvokeEvent, query?: ListMeetingsQuery): Meeting[] => {
      const opts = listMeetingsQuerySchema.parse(query ?? {});
      return store.listMeetings(opts);
    },
  );

  ipcMain.handle(IPC.searchMeetings, (_e: IpcMainInvokeEvent, query: string) => {
    return store.searchMeetings(typeof query === "string" ? query : "");
  });

  ipcMain.handle(
    IPC.getTranscript,
    (_e: IpcMainInvokeEvent, params: GetTranscriptParams): string => {
      const { id, variant } = getTranscriptParamsSchema.parse(params);
      return store.getTranscript(id, variant);
    },
  );

  ipcMain.handle(
    IPC.renameMeeting,
    (_e: IpcMainInvokeEvent, params: RenameMeetingParams): Meeting => {
      const { id, title } = renameMeetingParamsSchema.parse(params);
      // Mark the title user-owned so a later (re)generated summary never
      // overwrites it (see postprocess finalize's AI-title adoption).
      return store.updateMeeting(id, { title, titleEdited: true });
    },
  );

  ipcMain.handle(
    IPC.deleteMeeting,
    (_e: IpcMainInvokeEvent, params: DeleteMeetingParams): void => {
      const { id } = deleteMeetingParamsSchema.parse(params);
      // Never delete a meeting that's still recording (its files are in flight).
      if (controller.getActiveMeeting()?.id === id) {
        throw new Error("Cannot delete a meeting while it is still recording.");
      }
      store.deleteMeeting(id);
    },
  );

  // --- File import (PRD-12) ---
  // Validate the path/title (defense in depth — the renderer is untrusted), then
  // hand it to the import pipeline (mints the kind:"import" meeting + drives the
  // sidecar). Returns the created Meeting immediately.
  ipcMain.handle(
    IPC.importFile,
    (_e: IpcMainInvokeEvent, params: ImportFileParams): Meeting => {
      const parsed = importFileParamsSchema.parse(params);
      return importPipeline.importFile(parsed);
    },
  );

  // Open the native picker (main owns absolute paths in Electron 33+) and import
  // the chosen file. Returns null when the dialog is cancelled.
  ipcMain.handle(IPC.importFilePick, async (): Promise<Meeting | null> => {
    const win = getWindow?.() ?? null;
    const opts = {
      title: "Transcribe a file",
      properties: ["openFile"] as Array<"openFile">,
      filters: [
        { name: "Audio / Video", extensions: [...IMPORT_FILE_EXTENSIONS] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return null;
    return importPipeline.importFile({ filePath });
  });

  return () => {
    ipcMain.removeHandler(IPC.ping);
    ipcMain.removeHandler(IPC.getSidecarHealth);
    ipcMain.removeHandler(IPC.createMeeting);
    ipcMain.removeHandler(IPC.listMeetings);
    ipcMain.removeHandler(IPC.getMeeting);
    ipcMain.removeHandler(IPC.updateMeeting);
    ipcMain.removeHandler(IPC.startMeeting);
    ipcMain.removeHandler(IPC.stopMeeting);
    ipcMain.removeHandler(IPC.listMeetingsQuery);
    ipcMain.removeHandler(IPC.searchMeetings);
    ipcMain.removeHandler(IPC.getTranscript);
    ipcMain.removeHandler(IPC.renameMeeting);
    ipcMain.removeHandler(IPC.deleteMeeting);
    ipcMain.removeHandler(IPC.importFile);
    ipcMain.removeHandler(IPC.importFilePick);
  };
}

/**
 * Bridge the controller's lifecycle/status changes to a renderer push on
 * {@link IPC.meetingStatus}. Each transition (recording -> processing -> done /
 * error, and renames if the controller emits them) pushes the full updated
 * Meeting wrapped in a {@link import("@loqui/shared").MeetingStatusEvent} so the
 * Library/live view reacts without re-listing. Returns an unsubscribe fn;
 * `getWindow` resolves the live window at emit time so it survives window
 * recreation.
 */
export function pushMeetingStatus(
  controller: Pick<MeetingController, "onMeetingStatus">,
  getWindow: () => BrowserWindow | null,
): () => void {
  return controller.onMeetingStatus((meeting: Meeting) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.meetingStatus, { meeting });
    }
  });
}

/**
 * Wire the supervisor's status changes to a renderer push on
 * {@link IPC.sidecarStatus}. Returns an unsubscribe fn. The `getWindow`
 * callback lets the push survive window recreation (it resolves the live
 * window at emit time).
 */
export function pushSidecarStatus(
  supervisor: Pick<SidecarSupervisor, "onStatus">,
  getWindow: () => BrowserWindow | null,
): () => void {
  return supervisor.onStatus((status: SidecarStatus) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.sidecarStatus, status);
    }
  });
}

/**
 * Forward sidecar `transcriptSegment` WS notifications to the renderer on
 * {@link IPC.transcriptSegment} (PRD-2). Subscribes to the supervisor's
 * notification fan-out, filters to {@link TRANSCRIPT_SEGMENT_EVENT}, validates +
 * normalizes the payload with {@link transcriptSegmentSchema} (a malformed
 * segment is dropped, never forwarded), and pushes the parsed
 * {@link import("@loqui/shared").TranscriptSegment} to the live window. Returns
 * an unsubscribe fn. `getWindow` resolves the live window at emit time so the
 * push survives window recreation. Reuses the exact PRD-1 status/notification
 * wire pattern — no new transport.
 */
export function pushTranscriptSegments(
  supervisor: Pick<SidecarSupervisor, "onNotification">,
  getWindow: () => BrowserWindow | null,
): () => void {
  return supervisor.onNotification((event: string, data: unknown) => {
    if (event !== TRANSCRIPT_SEGMENT_EVENT) return;
    const parsed = transcriptSegmentSchema.safeParse(data);
    if (!parsed.success) return; // drop malformed segments, never forward.
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.transcriptSegment, parsed.data);
    }
  });
}
