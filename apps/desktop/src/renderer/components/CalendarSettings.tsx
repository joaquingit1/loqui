/**
 * CalendarSettings — connect/disconnect the user's calendars (PRD-15).
 *
 *   - One row per provider (Google / Microsoft 365 / Zoom) showing whether an
 *     account is connected, the connected account label + last-sync time, and a
 *     Connect or Disconnect button.
 *   - Connect runs the in-app OAuth flow in main (`calendar.connect(provider)`
 *     opens the system browser); the renderer only sees the resolved
 *     {connected, account} — tokens never reach it.
 *   - Disconnect clears the keychain tokens for that provider account.
 *   - A read-only-scope explainer: Loqui requests the narrowest read-only
 *     calendar scope and never writes to the calendar.
 *
 * READ-ONLY: nothing here writes a calendar or a transcript — it only connects
 * accounts and lists their status. Talks ONLY to the typed
 * window.loqui.calendar bridge (injectable for hermetic tests).
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type {
  CalendarConnection,
  CalendarProviderId,
} from "@loqui/shared";
import type { LoquiCalendarApi } from "../../preload/index.js";
import {
  calendarProviderLabel,
  formatLastSync,
} from "../home/format.js";
import "../home/home.css";

export interface CalendarSettingsProps {
  /** Calendar bridge. Injectable for tests; defaults to window.loqui.calendar. */
  api?: Pick<LoquiCalendarApi, "connect" | "disconnect" | "getConnections" | "onUpdated">;
  /** Called whenever connections change (so the host can refresh Home). */
  onConnectionsChanged?: (connections: CalendarConnection[]) => void;
}

const PROVIDERS: readonly CalendarProviderId[] = ["google", "microsoft", "zoom"];

/**
 * Providers not yet available to connect — shown dimmed with a quiet "Coming
 * soon" label instead of a Connect button. The backend providers stay registered
 * (only this UI gates them), so re-enabling one is just deleting it from here.
 */
const COMING_SOON: ReadonlySet<CalendarProviderId> = new Set(["microsoft", "zoom"]);

/** Read-only scope explainer copy per provider — surfaces exactly what's accessed. */
const PROVIDER_SCOPE: Record<CalendarProviderId, string> = {
  google: "Read-only access to your Google Calendar events (calendar.events.readonly).",
  microsoft: "Read-only access to your Outlook calendar (Calendars.Read).",
  zoom: "Read-only access to your scheduled Zoom meetings (meeting:read).",
};

export function CalendarSettings({
  api,
  onConnectionsChanged,
}: CalendarSettingsProps): JSX.Element {
  const cal = api ?? (typeof window !== "undefined" ? window.loqui?.calendar : undefined);

  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [busy, setBusy] = useState<CalendarProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyConnections = useCallback(
    (next: CalendarConnection[]) => {
      setConnections(next);
      onConnectionsChanged?.(next);
    },
    [onConnectionsChanged],
  );

  const reload = useCallback(() => {
    if (!cal?.getConnections) return;
    cal
      .getConnections()
      .then(applyConnections)
      .catch(() => {
        /* keep the last known connections */
      });
  }, [cal, applyConnections]);

  useEffect(() => {
    reload();
    if (!cal?.onUpdated) return;
    // The event-set push also implies connection state may have changed (e.g. a
    // token expired and dropped). Re-pull connections on each push.
    const unsubscribe = cal.onUpdated(() => reload());
    return unsubscribe;
  }, [cal, reload]);

  const onConnect = useCallback(
    (provider: CalendarProviderId) => {
      if (!cal?.connect) return;
      setBusy(provider);
      setError(null);
      cal
        .connect(provider)
        .then((result) => {
          if (!result.connected) {
            // Prefer the specific reason from main (e.g. "not configured — set
            // LOQUI_GOOGLE_CLIENT_ID") over a generic message.
            setError(
              result.reason ?? `Could not connect ${calendarProviderLabel(provider)}.`,
            );
          }
          reload();
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy((b) => (b === provider ? null : b)));
    },
    [cal, reload],
  );

  const onDisconnect = useCallback(
    (provider: CalendarProviderId, account: string) => {
      if (!cal?.disconnect) return;
      setBusy(provider);
      setError(null);
      cal
        .disconnect(provider, account || undefined)
        .then(() => reload())
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy((b) => (b === provider ? null : b)));
    },
    [cal, reload],
  );

  return (
    <section
      className="panel calendar-settings"
      aria-labelledby="calendar-settings-title"
      data-testid="calendar-settings"
    >
      <h2 className="panel__title" id="calendar-settings-title">
        Calendars
      </h2>
      <p className="panel__subtitle">
        Connect Google, Microsoft 365, or Zoom to see today’s meetings on your Home screen.
        Loqui reads your events <strong>read-only</strong> over an in-app sign-in — it never
        changes your calendar, and tokens stay in your OS keychain.
      </p>

      {error && (
        <p className="calendar-settings__error" data-testid="calendar-settings-error" role="status">
          {error}
        </p>
      )}

      <ul className="calendar-settings__rows">
        {PROVIDERS.map((provider) => {
          const accounts = connections.filter((c) => c.provider === provider);
          const isBusy = busy === provider;
          const comingSoon = COMING_SOON.has(provider);
          return (
            <li
              key={provider}
              className={`calendar-settings__row${comingSoon ? " calendar-settings__row--soon" : ""}`}
              data-testid={`calendar-provider-${provider}`}
              data-connected={accounts.length > 0 ? "true" : "false"}
              data-coming-soon={comingSoon ? "true" : undefined}
            >
              <div className="calendar-settings__row-head">
                <span className="calendar-settings__row-name">
                  {calendarProviderLabel(provider)}
                </span>
                {comingSoon ? (
                  <span className="calendar-settings__soon" data-testid={`calendar-soon-${provider}`}>
                    Coming soon
                  </span>
                ) : (
                  accounts.length === 0 && (
                    <button
                      type="button"
                      className="btn"
                      data-testid={`calendar-connect-${provider}`}
                      disabled={isBusy}
                      onClick={() => onConnect(provider)}
                    >
                      {isBusy ? "Connecting…" : "Connect"}
                    </button>
                  )
                )}
              </div>
              <p className="calendar-settings__scope">{PROVIDER_SCOPE[provider]}</p>

              {!comingSoon && accounts.length > 0 && (
                <ul className="calendar-settings__accounts">
                  {accounts.map((conn) => (
                    <li
                      key={`${provider}:${conn.account}`}
                      className="calendar-settings__account"
                      data-testid={`calendar-account-${provider}-${conn.account}`}
                    >
                      <span className="calendar-settings__account-info">
                        <span
                          className="status status--connected calendar-settings__badge"
                          data-testid={`calendar-account-status-${provider}`}
                        >
                          <span className="status__dot" />
                          {conn.account || "Connected"}
                        </span>
                        <span className="calendar-settings__sync">
                          {formatLastSync(conn.lastSyncAt)}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        data-testid={`calendar-disconnect-${provider}`}
                        disabled={isBusy}
                        onClick={() => onDisconnect(provider, conn.account)}
                      >
                        {isBusy ? "…" : "Disconnect"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
