/**
 * Preload script. Exposes a typed, minimal API to the renderer via
 * contextBridge ONLY. No Node globals are leaked (contextIsolation: true,
 * nodeIntegration: false).
 *
 * STUB: the concrete API surface (ping round-trip, sidecar status, meeting
 * CRUD bridge) is implemented in the Build phase. The shape below is the
 * contract the renderer types against.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { Health } from "@loqui/shared";
import { IPC } from "../shared/ipc.js";

export interface LoquiApi {
  /** Round-trips a ping main → sidecar → back. */
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
  /** Current sidecar health, or null if not connected. */
  getSidecarHealth(): Promise<Health | null>;
  /** Subscribe to sidecar status changes. Returns an unsubscribe fn. */
  onSidecarStatus(cb: (status: SidecarStatus) => void): () => void;
}

export type SidecarStatus = "connecting" | "connected" | "disconnected" | "error";

const api: LoquiApi = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  getSidecarHealth: () => ipcRenderer.invoke(IPC.getSidecarHealth),
  onSidecarStatus: (cb) => {
    const listener = (_e: unknown, status: SidecarStatus) => cb(status);
    ipcRenderer.on(IPC.sidecarStatus, listener);
    return () => ipcRenderer.removeListener(IPC.sidecarStatus, listener);
  },
};

contextBridge.exposeInMainWorld("loqui", api);
