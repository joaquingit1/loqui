/**
 * PRD-15 — main-process Calendar seams (interfaces / signatures ONLY).
 *
 * This file is the Foundation seam the two Build units implement against:
 *   - Build unit A (providers + service): implements {@link CalendarProvider}
 *     (FakeCalendarProvider + Google/Microsoft/Zoom), the {@link CalendarService},
 *     the {@link CalendarTokenStore}, and `register.ts`.
 *   - Build unit B (renderer): consumes `window.loqui.calendar` (preload) +
 *     the {@link CalendarEvent} shape from @loqui/shared.
 *
 * ARCHITECTURE (decisive): calendar integration lives ENTIRELY in the Electron
 * main process + renderer. The Python sidecar is NOT touched. ALL provider HTTP
 * is behind {@link CalendarProvider} and INJECTABLE, so tests mock it — NO real
 * network in any test (the sole permitted socket is a 127.0.0.1 one-shot OAuth
 * redirect listener, asserted to bind loopback only).
 *
 * READ-ONLY: nothing here writes a calendar (no create/update/delete) and
 * nothing writes a transcript file. Tokens live in the safeStorage keystore
 * (the PRD-4/5 keychain abstraction); they are never logged and never leave the
 * machine except in calls to the provider.
 *
 * Mirrors the PRD-4 ChatProvider / PRD-5 DiarizationBackend injectable-provider
 * shape: pure, swappable backends behind a small interface + a fake.
 */
import type {
  CalendarConnectResult,
  CalendarConnection,
  CalendarEvent,
  CalendarProviderId,
  ListUpcomingParams,
} from "@loqui/shared";

/**
 * The slice of Electron `safeStorage` the token store needs (injectable so unit
 * tests supply a fake — round-trip encrypt/decrypt with availability toggling —
 * without a real OS keychain). Identical shape to the PRD-4 keystore's
 * `SafeStorageLike`; the calendar token store REUSES the one keychain
 * abstraction (same data root, encrypted-at-rest, refuses the Linux basic_text
 * fallback).
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/**
 * OAuth tokens persisted for one connected account, encrypted via safeStorage.
 * `accessToken`/`refreshToken` are the provider-issued tokens; `expiresAt` is
 * the access-token expiry (ISO-8601) so the service refreshes transparently.
 * NEVER logged, never returned to the renderer.
 */
export interface CalendarOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope?: string | null;
}

/**
 * Secure per-account OAuth token storage (Build unit A implements; reuses the
 * safeStorage keystore mechanism). Keyed by (provider, account). `getConnections`
 * lists the connected accounts for the service to fan out over; `setTokens`
 * stores on connect; `clearTokens` clears on disconnect; `recordSync` stamps
 * lastSyncAt. The store is the ONLY place token material is touched.
 */
export interface CalendarTokenStore {
  /** Persist (encrypted) the tokens for an account, recording the connection. */
  setTokens(provider: CalendarProviderId, account: string, tokens: CalendarOAuthTokens): void;
  /** Decrypt + return an account's tokens, or null if none/decryption fails. */
  getTokens(provider: CalendarProviderId, account: string): CalendarOAuthTokens | null;
  /** Clear an account's tokens (or all of a provider's, when account omitted). */
  clearTokens(provider: CalendarProviderId, account?: string): void;
  /** List connected accounts (provider/account/lastSyncAt), never the tokens. */
  getConnections(): CalendarConnection[];
  /** Stamp an account's lastSyncAt to now (ISO-8601). */
  recordSync(provider: CalendarProviderId, account: string, at: string): void;
}

/**
 * Result of a provider's OAuth connect flow: the account label that was linked
 * plus the tokens to persist. Returned by {@link CalendarProvider.connect}; the
 * service writes the tokens to the {@link CalendarTokenStore}.
 */
export interface CalendarConnectOutcome {
  account: string;
  tokens: CalendarOAuthTokens;
}

/**
 * A pluggable calendar backend (FakeCalendarProvider + Google/Microsoft/Zoom).
 * ALL provider HTTP lives behind this interface and is INJECTABLE so tests mock
 * it. Methods are READ-ONLY over the provider's calendar (list only — no write).
 *
 * `id` identifies the source. `connect` runs the loopback-redirect PKCE OAuth
 * flow (open consent via shell.openExternal, one-shot 127.0.0.1 listener
 * captures the redirect, exchange code) and yields the account + tokens.
 * `listEvents` fetches + NORMALIZES raw provider events into {@link CalendarEvent}[]
 * for one account between [from, to) (extracting Meet/Teams/Zoom join links +
 * platform); it receives the account's tokens and a `refreshAccessToken` hook so
 * an expired access token is refreshed transparently. `disconnect` performs any
 * provider-side token revocation (best-effort); the service clears the store.
 */
export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** Run the OAuth connect flow; returns the linked account + tokens to persist. */
  connect(): Promise<CalendarConnectOutcome>;
  /** Best-effort provider-side revoke for an account's tokens (network behind the interface). */
  disconnect(tokens: CalendarOAuthTokens): Promise<void>;
  /** Mint a fresh access token from a refresh token (transparent refresh). */
  refreshAccessToken(tokens: CalendarOAuthTokens): Promise<CalendarOAuthTokens>;
  /** Fetch + normalize one account's events in [from, to) into CalendarEvent[]. */
  listEvents(
    tokens: CalendarOAuthTokens,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]>;
}

/**
 * The main calendar service (Build unit A implements). Fans out over connected
 * accounts via injected {@link CalendarProvider}s, normalizes + merges +
 * de-duplicates events across accounts (same invite in two calendars), sorts
 * soonest-first, caches with a short TTL + manual refresh, and emits a
 * `calendar:updated` push when the set changes. Backs every `window.loqui.calendar`
 * channel. Read-only; never writes a transcript.
 */
export interface CalendarService {
  /** Today's events across all connected accounts, soonest-first, de-duplicated. */
  listToday(): Promise<CalendarEvent[]>;
  /** Upcoming events within the given window (defaults applied), soonest-first. */
  listUpcoming(params?: ListUpcomingParams): Promise<CalendarEvent[]>;
  /** Run a provider's OAuth connect flow + persist tokens; returns connect result. */
  connect(provider: CalendarProviderId): Promise<CalendarConnectResult>;
  /** Disconnect a provider account (clears keychain tokens); resolves when done. */
  disconnect(provider: CalendarProviderId, account?: string): Promise<void>;
  /** List connected accounts (provider/account/lastSyncAt). Never returns tokens. */
  getConnections(): Promise<CalendarConnection[]>;
  /** Force a re-sync across all accounts; returns the refreshed event set. */
  refresh(): Promise<CalendarEvent[]>;
  /**
   * Subscribe to event-set changes (poll interval + on-focus + manual refresh).
   * The callback fires with the full current event set; returns an unsubscribe fn.
   */
  onUpdated(cb: (events: CalendarEvent[]) => void): () => void;
  /** Stop polling + release timers/listeners. Idempotent. */
  dispose(): void;
}

/** Map of provider id -> {@link CalendarProvider}, injected into the service (fakes in tests). */
export type CalendarProviderRegistry = Partial<Record<CalendarProviderId, CalendarProvider>>;

/**
 * SIGNATURE Build unit A implements in `register.ts`: bind the
 * `window.loqui.calendar` IPC channels to the {@link CalendarService} and push
 * `calendar:updated` to the renderer. Returns a disposer (mirrors registerMcpIpc
 * / registerChatIpc). `getWindow` resolves the live window at emit time.
 */
export interface CalendarIpcDeps {
  service: CalendarService;
  getWindow: () => import("electron").BrowserWindow | null;
}
export type RegisterCalendarIpc = (deps: CalendarIpcDeps) => () => void;
