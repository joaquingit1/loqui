/**
 * Export + capture/privacy IPC registration (PRD-13).
 *
 * Binds the `window.loqui.export` + `window.loqui.privacy` bridges (see
 * src/preload/index.ts) to the {@link ExportService}, the {@link SettingsStore},
 * and the per-app capability probe. Every payload is re-validated here (defense
 * in depth — the renderer is untrusted).
 *
 * Channel names come from src/shared/ipc.ts (the single source). The export
 * surface is READ-ONLY over the canonical transcript; the privacy surface only
 * persists non-secret settings + (via `applyContentProtection`) toggles the
 * window content-protection flag.
 */
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  exportMeetingParamsSchema,
  updateCaptureSettingsSchema,
  type CaptureCapability,
  type CaptureSettings,
  type ExportMeetingParams,
  type ExportResult,
  type UpdateCaptureSettings,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { ExportService } from "./service.js";
import type { SettingsStore } from "../settings/store.js";
import {
  decideCaptureMode,
  type CaptureCapabilityProbe,
} from "../capture/perapp.js";

export interface ExportIpcDeps {
  exportService: ExportService;
  settings: SettingsStore;
  /** The per-app system-audio capability probe (injected for tests). */
  captureProbe: CaptureCapabilityProbe;
  /**
   * Apply the content-protection flag to the live window(s). Called when the
   * `contentProtection` setting changes so the toggle takes effect without a
   * restart. Injected so the handler stays headless-testable.
   */
  applyContentProtection?: (enabled: boolean) => void;
  /** Resolve the live window (the modal dir-picker parent). Optional. */
  getWindow?: () => BrowserWindow | null;
}

/**
 * Register the export + privacy invoke handlers. Returns a disposer that removes
 * them (used on app teardown / window recreation).
 */
export function registerExportIpc(deps: ExportIpcDeps): () => void {
  const { exportService, settings, captureProbe, applyContentProtection, getWindow } = deps;

  ipcMain.handle(
    IPC.exportMeeting,
    (_e: IpcMainInvokeEvent, params: ExportMeetingParams): Promise<ExportResult> => {
      const parsed = exportMeetingParamsSchema.parse(params);
      return exportService.exportMeeting(parsed);
    },
  );

  // Native directory-picker for the export/storage dir; persists the choice.
  ipcMain.handle(IPC.exportPickDir, async (): Promise<string | null> => {
    const win = getWindow?.() ?? null;
    const opts = {
      title: "Choose export folder",
      properties: ["openDirectory", "createDirectory"] as Array<
        "openDirectory" | "createDirectory"
      >,
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    settings.setCaptureSettings({ exportDir: dir });
    return dir;
  });

  ipcMain.handle(IPC.getCaptureSettings, (): CaptureSettings => {
    return settings.getCaptureSettings();
  });

  ipcMain.handle(
    IPC.setCaptureSettings,
    (_e: IpcMainInvokeEvent, patch: UpdateCaptureSettings): CaptureSettings => {
      const clean = updateCaptureSettingsSchema.parse(patch ?? {});
      const updated = settings.setCaptureSettings(clean);
      // Apply the content-protection toggle to the live window(s) immediately.
      if (clean.contentProtection !== undefined) {
        applyContentProtection?.(updated.contentProtection);
      }
      return updated;
    },
  );

  ipcMain.handle(IPC.getCaptureCapability, (): CaptureCapability => {
    const perApp = settings.getCaptureSettings().perAppAudioFilter;
    return decideCaptureMode(perApp, captureProbe);
  });

  return () => {
    ipcMain.removeHandler(IPC.exportMeeting);
    ipcMain.removeHandler(IPC.exportPickDir);
    ipcMain.removeHandler(IPC.getCaptureSettings);
    ipcMain.removeHandler(IPC.setCaptureSettings);
    ipcMain.removeHandler(IPC.getCaptureCapability);
  };
}
