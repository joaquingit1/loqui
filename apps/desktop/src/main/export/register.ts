/**
 * Export IPC registration (PRD-13).
 *
 * Binds the `window.loqui.export` bridge (see src/preload/index.ts) to the
 * {@link ExportService}. The payload is re-validated here (defense in depth —
 * the renderer is untrusted).
 *
 * Channel names come from src/shared/ipc.ts (the single source). The export
 * surface is READ-ONLY over the canonical transcript: it builds a model from the
 * diarized transcript (else the live transcript) + summary and writes a NEW file.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  exportMeetingParamsSchema,
  type ExportMeetingParams,
  type ExportResult,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { ExportService } from "./service.js";

export interface ExportIpcDeps {
  exportService: ExportService;
}

/**
 * Register the export invoke handler. Returns a disposer that removes it (used
 * on app teardown / window recreation).
 */
export function registerExportIpc(deps: ExportIpcDeps): () => void {
  const { exportService } = deps;

  ipcMain.handle(
    IPC.exportMeeting,
    (_e: IpcMainInvokeEvent, params: ExportMeetingParams): Promise<ExportResult> => {
      const parsed = exportMeetingParamsSchema.parse(params);
      return exportService.exportMeeting(parsed);
    },
  );

  return () => {
    ipcMain.removeHandler(IPC.exportMeeting);
  };
}
