/**
 * Loqui home screen.
 *
 * Renders the app title, a live sidecar-status indicator (driven by
 * window.loqui.onSidecarStatus), and a Debug panel with a "Ping sidecar"
 * button that round-trips window.loqui.ping() and shows the result + latency.
 *
 * The renderer ONLY talks to the typed window.loqui bridge — never to ipc
 * channels or Node globals directly.
 */
import { useEffect, useState } from "react";
import type { LoquiApi, SidecarStatus } from "../preload/index.js";
import { SidecarStatusBadge } from "./components/SidecarStatusBadge.js";
import { DebugPanel } from "./components/DebugPanel.js";

declare global {
  interface Window {
    loqui: LoquiApi;
  }
}

export type { SidecarStatus };

export interface AppProps {
  /** Injectable for tests; defaults to the contextBridge-exposed window.loqui. */
  api?: LoquiApi;
  /** Initial status before the first push arrives. */
  initialStatus?: SidecarStatus;
}

export function App({ api, initialStatus = "connecting" }: AppProps): JSX.Element {
  const [status, setStatus] = useState<SidecarStatus>(initialStatus);

  useEffect(() => {
    const loqui = api ?? window.loqui;
    // window.loqui is absent in non-Electron contexts (e.g. plain unit render);
    // guard so the home screen still renders its initial status.
    if (!loqui?.onSidecarStatus) return;
    const unsubscribe = loqui.onSidecarStatus(setStatus);
    return unsubscribe;
  }, [api]);

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">Loqui</h1>
          <p className="app__tagline">Local-first meeting transcription.</p>
        </div>
        <SidecarStatusBadge status={status} />
      </header>

      <DebugPanel api={api} />
    </main>
  );
}
