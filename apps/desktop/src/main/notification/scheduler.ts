/**
 * @file Meeting-notification scheduler — the pure core that decides WHEN to fire
 * the "Meeting Detected" desktop popup (~1 minute before a scheduled calendar
 * meeting starts).
 *
 * It owns NO Electron/window/IO state: it takes the calendar event set (pushed by
 * the calendar service) and an injected clock + timers, arms one timer per
 * upcoming meeting at `startsAt − leadMs`, and calls `onFire(event)` at most once
 * per event id. The caller (main bootstrap) wires `onFire` to show the popup
 * window. This keeps the timing logic deterministic + unit-testable with fake
 * timers, exactly like the auto-record engine (`autorecord/engine.ts`).
 *
 * Firing predicate (so we don't alert for personal calendar blocks): the event
 * must look like a real meeting — it has a join link OR at least one attendee —
 * is not already linked to a recording (`meetingId`), and (at fire time) no
 * recording is already active. Events first observed already past their lead
 * point but not yet started fire immediately; events already well past their
 * start are dropped (no stale alerts).
 */
import type { CalendarEvent } from "@loqui/shared";

/** Default lead time before `startsAt` to fire the popup (1 minute). */
export const NOTIFICATION_DEFAULT_LEAD_MS = 60_000;

/**
 * How long AFTER a meeting's start we'll still fire a not-yet-shown alert when an
 * event is first observed inside the window (e.g. the app just launched). Past
 * this, the meeting is "too late" and we stay silent.
 */
export const NOTIFICATION_LATE_GRACE_MS = 2 * 60_000;

export interface MeetingNotificationSchedulerDeps {
  /** Fired when a meeting reaches its lead point. At most once per event id. */
  onFire: (event: CalendarEvent) => void;
  /** Wall clock (epoch ms). Defaults to Date.now; tests inject a controllable one. */
  now?: () => number;
  /** Lead time before `startsAt` to fire. Defaults to {@link NOTIFICATION_DEFAULT_LEAD_MS}. */
  leadMs?: number;
  /**
   * Optional "a recording is already active" probe. When it returns true at fire
   * time the popup is suppressed (only one recording at a time — alerting would
   * be a dead end). Absent → never suppressed.
   */
  isActive?: () => boolean;
  /** Injectable timers (tests pass fake-timer-aware fns). */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Optional diagnostic sink (main passes one when LOQUI_DEBUG_NOTIFY is set). */
  log?: (msg: string) => void;
}

export interface MeetingNotificationScheduler {
  /**
   * Re-evaluate against the latest event set: arm timers for newly-upcoming
   * meetings, cancel timers for events that vanished / got linked / shifted.
   * Idempotent — re-passing an unchanged set neither re-arms nor re-fires.
   */
  update(events: CalendarEvent[]): void;
  /** Clear every armed timer + internal state. */
  dispose(): void;
}

/**
 * Should this event raise a "Meeting Detected" alert? Fires for any timed event
 * on the calendar — all-day blocks (no real start time) and events already linked
 * to a recording are excluded.
 */
export function isAlertableMeeting(event: CalendarEvent): boolean {
  if (event.meetingId) return false; // already linked to a recording
  if (event.allDay) return false; // no real start time
  return true;
}

export function createMeetingNotificationScheduler(
  deps: MeetingNotificationSchedulerDeps,
): MeetingNotificationScheduler {
  const now = deps.now ?? Date.now;
  const leadMs = deps.leadMs ?? NOTIFICATION_DEFAULT_LEAD_MS;
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const log = deps.log ?? ((): void => {});

  // Armed timers keyed by event id, tracking the fireAt they were armed for so an
  // event whose start time shifts is cleanly re-armed.
  const armed = new Map<string, { handle: ReturnType<typeof setTimeout>; fireAt: number }>();
  // Event ids already fired (or deliberately skipped as too-late) — never re-fire.
  const handled = new Set<string>();

  function fire(event: CalendarEvent): void {
    armed.delete(event.id);
    if (handled.has(event.id)) return;
    handled.add(event.id);
    if (deps.isActive?.()) {
      log(`suppress "${event.title}" (${event.id}): a recording is already active`);
      return; // a recording is already running — stay silent
    }
    log(`onFire "${event.title}" (${event.id})`);
    deps.onFire(event);
  }

  function update(events: CalendarEvent[]): void {
    const present = new Set<string>();
    log(`update: ${events.length} event(s); now=${new Date(now()).toISOString()}`);

    for (const event of events) {
      if (!event.id) continue;
      if (!isAlertableMeeting(event)) {
        log(
          `skip "${event.title}" (${event.id}): not alertable ` +
            `(allDay=${event.allDay}, meetingId=${event.meetingId ?? "none"})`,
        );
        continue;
      }
      const startMs = Date.parse(event.startsAt);
      if (Number.isNaN(startMs)) continue;
      present.add(event.id);

      if (handled.has(event.id)) continue; // already fired/skipped
      const fireAt = startMs - leadMs;
      const existing = armed.get(event.id);
      log(
        `consider "${event.title}" (${event.id}): startsAt=${event.startsAt}, ` +
          `fireIn=${Math.round((fireAt - now()) / 1000)}s`,
      );

      if (now() >= fireAt) {
        // We're already at/past the lead point. Fire now if still timely, else
        // mark handled so a long-past event never alerts.
        if (existing) {
          clearTimer(existing.handle);
          armed.delete(event.id);
        }
        if (now() <= startMs + NOTIFICATION_LATE_GRACE_MS) {
          log(`fire-now "${event.title}" (${event.id})`);
          fire(event);
        } else {
          log(`skip "${event.title}" (${event.id}): already past start+grace`);
          handled.add(event.id);
        }
        continue;
      }

      // Future fire point: (re)arm only if not already armed for this exact time.
      if (existing && existing.fireAt === fireAt) continue;
      if (existing) clearTimer(existing.handle);
      const handle = setTimer(() => fire(event), fireAt - now());
      armed.set(event.id, { handle, fireAt });
      log(`armed "${event.title}" (${event.id}) to fire in ${Math.round((fireAt - now()) / 1000)}s`);
    }

    // Cancel timers for events that disappeared / got linked / no longer qualify.
    for (const [id, entry] of armed) {
      if (!present.has(id)) {
        clearTimer(entry.handle);
        armed.delete(id);
      }
    }
    // Bound the handled set: forget ids no longer in the current window.
    for (const id of handled) {
      if (!present.has(id)) handled.delete(id);
    }
  }

  function dispose(): void {
    for (const { handle } of armed.values()) clearTimer(handle);
    armed.clear();
    handled.clear();
  }

  return { update, dispose };
}
