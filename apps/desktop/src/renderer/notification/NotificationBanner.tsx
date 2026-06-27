/**
 * NotificationBanner — the contents of the frameless "Meeting Detected" popup
 * window. Subscribes to the main-process push (`notifications.onMeetingDetected`)
 * for the imminent {@link CalendarEvent}, shows the meeting + how soon it starts,
 * and offers "Join & Record" (hands off to main, which opens the link + drives
 * the main window's start flow) or dismiss.
 *
 * READ-ONLY + delegating: it never starts a recording itself. Talks ONLY to the
 * typed `window.loqui.notifications` bridge (injectable for hermetic tests).
 */
import { useEffect, useState, type JSX } from "react";
import type { CalendarEvent } from "@loqui/shared";
import type { LoquiNotificationsApi } from "../../preload/index.js";
import { Icon } from "../components/Icon.js";
import { formatRelativeStart } from "../home/format.js";

export interface NotificationBannerProps {
  /** Notifications bridge. Injectable for tests; defaults to window.loqui.notifications. */
  api?: Pick<LoquiNotificationsApi, "onMeetingDetected" | "join" | "dismiss">;
  /** Reference "now" for the relative-start label; injectable so tests are deterministic. */
  now?: Date;
}

export function NotificationBanner({ api, now }: NotificationBannerProps): JSX.Element | null {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.notifications : undefined);
  const [event, setEvent] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    if (!bridge?.onMeetingDetected) return;
    return bridge.onMeetingDetected((e) => setEvent(e));
  }, [bridge]);

  if (!event) return null;
  const rel = formatRelativeStart(event.startsAt, now);

  return (
    <div className="notif" data-testid="notif">
      <div className="notif__head">
        <span className="notif__dot" aria-hidden="true" />
        <span className="notif__eyebrow">Meeting Detected</span>
        <button
          type="button"
          className="notif__dismiss"
          data-testid="notif-dismiss"
          aria-label="Dismiss"
          onClick={() => void bridge?.dismiss()}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <p className="notif__title" data-testid="notif-title">
        {event.title || "Untitled meeting"}
        {rel && <span className="notif__rel"> · {rel}</span>}
      </p>
      <button
        type="button"
        className="btn notif__join"
        data-testid="notif-join"
        onClick={() => void bridge?.join(event.id)}
      >
        {event.joinUrl ? "Join & Record" : "Record"}
      </button>
    </div>
  );
}
