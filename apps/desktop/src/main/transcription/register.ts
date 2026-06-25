/**
 * PRD-9 — transcription-engine IPC registration.
 *
 * Binds the `window.loqui.transcription` bridge (see src/preload/index.ts) to the
 * {@link SettingsStore}: read/patch the persisted engine/model/language settings
 * and list the selectable engines + their availability on this OS/arch. Every
 * payload is re-validated here (defense in depth — the renderer is untrusted).
 *
 * The setting takes effect for the NEXT meeting: the sidecar reads the chosen
 * engine at launch via the LOQUI_TRANSCRIPTION_* env contract (see
 * makeTranscriptionEnv + the supervisor). No secrets here.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  updateTranscriptionSettingsSchema,
  type TranscriptionEngineInfo,
  type TranscriptionSettings,
  type UpdateTranscriptionSettings,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { SettingsStore } from "../settings/store.js";
import { buildEngineList } from "./engines.js";

export interface TranscriptionIpcDeps {
  settings: SettingsStore;
  /** The host platform (a `process.platform` value). Injected for tests. */
  platform?: string;
}

/**
 * Register the transcription invoke handlers. Returns a disposer that removes
 * them (used on app teardown / window recreation).
 */
export function registerTranscriptionIpc(deps: TranscriptionIpcDeps): () => void {
  const { settings } = deps;
  const platform = deps.platform ?? process.platform;

  ipcMain.handle(IPC.getTranscriptionSettings, (): TranscriptionSettings => {
    return settings.getTranscriptionSettings();
  });

  ipcMain.handle(
    IPC.setTranscriptionSettings,
    (_e: IpcMainInvokeEvent, patch: UpdateTranscriptionSettings): TranscriptionSettings => {
      const clean = updateTranscriptionSettingsSchema.parse(patch ?? {});
      return settings.setTranscriptionSettings(clean);
    },
  );

  ipcMain.handle(IPC.getTranscriptionEngines, (): TranscriptionEngineInfo[] => {
    return buildEngineList(platform);
  });

  return () => {
    ipcMain.removeHandler(IPC.getTranscriptionSettings);
    ipcMain.removeHandler(IPC.setTranscriptionSettings);
    ipcMain.removeHandler(IPC.getTranscriptionEngines);
  };
}
