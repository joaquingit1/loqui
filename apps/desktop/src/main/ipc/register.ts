/**
 * IPC handler registration. The single place the main process binds the
 * `window.loqui` surface (defined in src/preload/index.ts) to the sidecar
 * supervisor and the meeting store.
 *
 * Channel names come from src/shared/ipc.ts (the single source). The renderer
 * never references channels directly — it only sees the typed `window.loqui`
 * API exposed via contextBridge.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  TRANSCRIPT_SEGMENT_EVENT,
  transcriptSegmentSchema,
  type CreateMeetingInput,
  type Health,
  type UpdateMeetingInput,
} from "@loqui/shared";
import type { SidecarStatus } from "../../preload/index.js";
import { IPC } from "../../shared/ipc.js";
import type { SidecarSupervisor } from "../sidecar/supervisor.js";
import type { MeetingStore } from "../store/index.js";

export interface IpcDeps {
  supervisor: Pick<SidecarSupervisor, "ping" | "getHealth" | "onStatus">;
  store: MeetingStore;
}

/**
 * Register every invoke handler against `ipcMain`. Returns a disposer that
 * removes them (used on app teardown / window recreation).
 */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const { supervisor, store } = deps;

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

  return () => {
    ipcMain.removeHandler(IPC.ping);
    ipcMain.removeHandler(IPC.getSidecarHealth);
    ipcMain.removeHandler(IPC.createMeeting);
    ipcMain.removeHandler(IPC.listMeetings);
    ipcMain.removeHandler(IPC.getMeeting);
    ipcMain.removeHandler(IPC.updateMeeting);
  };
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
