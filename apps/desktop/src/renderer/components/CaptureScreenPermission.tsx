/**
 * macOS Screen-Recording permission messaging for system-audio capture (PRD-1).
 *
 * The status is pushed from main (Electron `systemPreferences.getMediaAccessStatus
 * ("screen")`). On non-macOS the status is `not-applicable` and this renders
 * nothing. Otherwise it explains why the grant is needed and points the user to
 * System Settings, including the "needs restart after granting" case.
 */
import type { ScreenPermissionStatus } from "@loqui/shared";

export interface CaptureScreenPermissionProps {
  status: ScreenPermissionStatus | null;
}

interface Notice {
  tone: "info" | "warn" | "error";
  title: string;
  body: string;
}

function noticeFor(status: ScreenPermissionStatus): Notice | null {
  switch (status) {
    case "granted":
    case "not-applicable":
      return null;
    case "not-determined":
      return {
        tone: "info",
        title: "System audio needs Screen Recording access",
        body: "macOS routes loopback (system) audio through the Screen Recording permission. Starting the 'They (system)' stream will prompt you to allow Loqui.",
      };
    case "denied":
      return {
        tone: "warn",
        title: "Screen Recording is denied",
        body: "To capture system audio, enable Loqui under System Settings → Privacy & Security → Screen Recording, then relaunch Loqui (macOS requires a restart of the app after granting).",
      };
    case "restricted":
      return {
        tone: "error",
        title: "Screen Recording is restricted",
        body: "Screen Recording is blocked by a device-management policy, so system audio can't be captured on this machine. Microphone capture still works.",
      };
    default:
      return null;
  }
}

export function CaptureScreenPermission({
  status,
}: CaptureScreenPermissionProps): JSX.Element | null {
  if (!status) return null;
  const notice = noticeFor(status);
  if (!notice) return null;
  return (
    <div
      className={`perm perm--${notice.tone}`}
      role="note"
      data-testid="screen-permission"
      data-status={status}
    >
      <strong className="perm__title">{notice.title}</strong>
      <p className="perm__body">{notice.body}</p>
    </div>
  );
}
