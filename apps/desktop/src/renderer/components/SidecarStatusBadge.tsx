/**
 * Sidecar connection status badge. Pure presentation — the live status is
 * owned by <App> (driven by window.loqui.onSidecarStatus).
 *
 * Color mapping:
 *   connected    -> green
 *   connecting   -> amber (pulsing)
 *   disconnected -> slate
 *   error        -> red
 */
import type { SidecarStatus } from "../../preload/index.js";

const LABEL: Record<SidecarStatus, string> = {
  connecting: "Starting…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Error",
};

export interface SidecarStatusBadgeProps {
  status: SidecarStatus;
}

export function SidecarStatusBadge({ status }: SidecarStatusBadgeProps): JSX.Element {
  return (
    <span
      className={`status status--${status}`}
      role="status"
      aria-live="polite"
      data-testid="sidecar-status"
      data-status={status}
    >
      <span className="status__dot" aria-hidden="true" />
      <span>Sidecar: {LABEL[status]}</span>
    </span>
  );
}
