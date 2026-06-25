/**
 * PRD-15 — the main-process Calendar service.
 *
 * Implements the {@link CalendarService} seam: fans out over connected accounts
 * via the injected {@link CalendarProvider}s, NORMALIZES each provider's events
 * into {@link CalendarEvent}[], MERGES + DE-DUPLICATES across accounts (the same
 * invite landing in two calendars), SORTS soonest-first, CACHES with a short TTL
 * (+ manual `refresh`), and emits a `calendar:updated` push when the set CHANGES
 * (poll interval + manual refresh; the renderer also pings refresh on focus).
 *
 * `connect` runs a provider's OAuth flow and persists the issued tokens via the
 * injected {@link CalendarTokenStore} (the safeStorage keystore). `disconnect`
 * clears the keystore tokens (best-effort provider revoke first). Token refresh
 * is transparent: a request that 401s / has an expired access token refreshes
 * via the provider and re-persists.
 *
 * EVENT ↔ RECORDING LINKING: `linkMeeting(eventId, meetingId)` stamps the
 * matching cached event's `meetingId` (set when "join & record" starts a
 * recording from an event) and re-emits — so the Home view shows the link.
 * This is the ONLY mutation the service performs on an event, and it touches
 * NO calendar API and NO transcript file.
 *
 * READ-ONLY + HERMETIC: all provider HTTP is behind the injectable
 * {@link CalendarProvider}; the service itself opens no socket. Nothing here
 * writes a calendar or a transcript.
 */
import {
  listUpcomingParamsSchema,
  type CalendarConnection,
  type CalendarConnectResult,
  type CalendarEvent,
  type CalendarProviderId,
  type ListUpcomingParams,
} from "@loqui/shared";
import type {
  CalendarProvider,
  CalendarProviderRegistry,
  CalendarService,
  CalendarTokenStore,
  CalendarOAuthTokens,
} from "./types.js";

/** The concrete service adds `linkMeeting` on top of the {@link CalendarService} seam. */
export interface CalendarServiceImpl extends CalendarService {
  /**
   * Link a cached event to a started recording (sets `meetingId`) + re-emits.
   * Returns the linked event, or null if no cached event matched. READ-ONLY over
   * the calendar — only stamps the in-memory/normalized event.
   */
  linkMeeting(eventId: string, meetingId: string): CalendarEvent | null;
}

export interface CreateCalendarServiceDeps {
  /** Per-account OAuth token storage (safeStorage keystore). */
  tokenStore: CalendarTokenStore;
  /** Injected providers (fakes in tests). Missing providers reject connect. */
  providers: CalendarProviderRegistry;
  /** Cache TTL in ms (default 60s). A list within the TTL serves the cache. */
  cacheTtlMs?: number;
  /** Background poll interval in ms (default 5 min); <= 0 disables polling. */
  pollIntervalMs?: number;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Schedule a repeating timer; injectable so tests run without real timers. */
  setInterval?: (cb: () => void, ms: number) => { unref?: () => void } | number;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;
/** How far ahead `listToday`/the cache fetches (covers the upcoming window too). */
const FETCH_HORIZON_HOURS = 24 * 7;

export function createCalendarService(deps: CreateCalendarServiceDeps): CalendarServiceImpl {
  const { tokenStore, providers } = deps;
  const now = deps.now ?? Date.now;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const scheduleInterval = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const cancelInterval = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));

  // In-memory cache of the merged event set + when it was fetched.
  let cache: CalendarEvent[] = [];
  let fetchedAtMs = 0;
  // Meeting-id links applied locally (eventId -> meetingId), re-applied after a
  // fetch replaces the cache so a link survives a re-sync.
  const links = new Map<string, string>();
  const listeners = new Set<(events: CalendarEvent[]) => void>();
  let pollHandle: { unref?: () => void } | number | null = null;
  let disposed = false;

  function getProvider(id: CalendarProviderId): CalendarProvider {
    const p = providers[id];
    if (!p) throw new Error(`calendar: no provider registered for "${id}"`);
    return p;
  }

  /** Apply the local meetingId links onto an event set (pure). */
  function withLinks(events: CalendarEvent[]): CalendarEvent[] {
    if (links.size === 0) return events;
    return events.map((e) => {
      const linked = links.get(e.id);
      return linked && e.meetingId !== linked ? { ...e, meetingId: linked } : e;
    });
  }

  /**
   * Fetch one account's events, refreshing the access token transparently if a
   * list throws (likely-expired token). Persists a refreshed token + stamps the
   * sync. Returns [] on a hard failure so one bad account never blanks the rest.
   */
  async function fetchAccount(
    provider: CalendarProvider,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]> {
    let tokens = tokenStore.getTokens(provider.id, account);
    if (!tokens) return [];
    // Proactive refresh when the stored access token is past its expiry.
    if (isExpired(tokens, now())) {
      tokens = await tryRefresh(provider, account, tokens);
      if (!tokens) return [];
    }
    try {
      const events = await provider.listEvents(tokens, account, range);
      tokenStore.recordSync(provider.id, account, new Date(now()).toISOString());
      return events;
    } catch {
      // Likely an expired/invalid access token — refresh once and retry.
      const refreshed = await tryRefresh(provider, account, tokens);
      if (!refreshed) return [];
      try {
        const events = await provider.listEvents(refreshed, account, range);
        tokenStore.recordSync(provider.id, account, new Date(now()).toISOString());
        return events;
      } catch {
        return [];
      }
    }
  }

  async function tryRefresh(
    provider: CalendarProvider,
    account: string,
    tokens: CalendarOAuthTokens,
  ): Promise<CalendarOAuthTokens | null> {
    if (!tokens.refreshToken) return null;
    try {
      const next = await provider.refreshAccessToken(tokens);
      tokenStore.setTokens(provider.id, account, next);
      return next;
    } catch {
      return null;
    }
  }

  /** Fan out over every connected account, merge + dedup + sort, return the set. */
  async function fetchAll(): Promise<CalendarEvent[]> {
    const range = { from: new Date(now()), to: new Date(now() + FETCH_HORIZON_HOURS * 3600_000) };
    const connections = tokenStore.getConnections();
    const batches = await Promise.all(
      connections.map((c) => {
        const provider = providers[c.provider];
        if (!provider) return Promise.resolve<CalendarEvent[]>([]);
        return fetchAccount(provider, c.account, range);
      }),
    );
    return sortSoonestFirst(dedupe(batches.flat()));
  }

  /** Refresh the cache + emit if the set changed. Returns the new set. */
  async function syncAndEmit(): Promise<CalendarEvent[]> {
    const fetched = withLinks(await fetchAll());
    const changed = !eventsEqual(fetched, cache);
    cache = fetched;
    fetchedAtMs = now();
    if (changed) emit();
    return cache;
  }

  function emit(): void {
    const snapshot = cache.slice();
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch {
        /* a listener throwing must not break the others */
      }
    }
  }

  /** Serve the cache when fresh; otherwise re-sync. */
  async function current(): Promise<CalendarEvent[]> {
    if (now() - fetchedAtMs < cacheTtlMs && fetchedAtMs > 0) return cache;
    return syncAndEmit();
  }

  function ensurePolling(): void {
    if (disposed || pollHandle !== null || pollIntervalMs <= 0) return;
    pollHandle = scheduleInterval(() => {
      void syncAndEmit().catch(() => {
        /* a background poll failure is non-fatal */
      });
    }, pollIntervalMs);
    if (pollHandle && typeof pollHandle === "object" && typeof pollHandle.unref === "function") {
      pollHandle.unref();
    }
  }

  const service: CalendarServiceImpl = {
    async listToday(): Promise<CalendarEvent[]> {
      const events = await current();
      const today = new Date(now());
      return events.filter((e) => isSameLocalDay(e.startsAt, today));
    },

    async listUpcoming(params?: ListUpcomingParams): Promise<CalendarEvent[]> {
      const { withinHours, limit } = listUpcomingParamsSchema.parse(params ?? {});
      const events = await current();
      const horizon = now() + withinHours * 3600_000;
      return events
        .filter((e) => {
          const t = new Date(e.startsAt).getTime();
          return t >= now() - 60_000 && t <= horizon;
        })
        .slice(0, limit);
    },

    async connect(provider: CalendarProviderId): Promise<CalendarConnectResult> {
      try {
        const p = getProvider(provider);
        const { account, tokens } = await p.connect();
        tokenStore.setTokens(provider, account, tokens);
        ensurePolling();
        // Eagerly sync so the Home view sees this account's events immediately.
        await syncAndEmit();
        return { connected: true, account };
      } catch (err) {
        // A cancelled / failed connect leaves nothing persisted. Surface the
        // REASON (e.g. "not configured — set LOQUI_GOOGLE_CLIENT_ID") so the UI
        // can tell the user WHY instead of a generic "could not connect".
        return {
          connected: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async disconnect(provider: CalendarProviderId, account?: string): Promise<void> {
      // Best-effort provider-side revoke for each affected account.
      const targets = tokenStore
        .getConnections()
        .filter((c) => c.provider === provider && (account === undefined || c.account === account));
      const p = providers[provider];
      if (p) {
        await Promise.all(
          targets.map(async (c) => {
            const tokens = tokenStore.getTokens(provider, c.account);
            if (tokens) {
              try {
                await p.disconnect(tokens);
              } catch {
                /* revoke is best-effort; we clear the store regardless */
              }
            }
          }),
        );
      }
      tokenStore.clearTokens(provider, account);
      // Drop the disconnected account's events from the cache + re-emit.
      await syncAndEmit();
    },

    getConnections(): Promise<CalendarConnection[]> {
      return Promise.resolve(tokenStore.getConnections());
    },

    refresh(): Promise<CalendarEvent[]> {
      return syncAndEmit();
    },

    onUpdated(cb: (events: CalendarEvent[]) => void): () => void {
      listeners.add(cb);
      ensurePolling();
      return () => {
        listeners.delete(cb);
      };
    },

    linkMeeting(eventId: string, meetingId: string): CalendarEvent | null {
      links.set(eventId, meetingId);
      let linked: CalendarEvent | null = null;
      cache = cache.map((e) => {
        if (e.id === eventId) {
          linked = { ...e, meetingId };
          return linked;
        }
        return e;
      });
      if (linked) emit();
      return linked;
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
      if (pollHandle !== null) {
        cancelInterval(pollHandle);
        pollHandle = null;
      }
    },
  };

  return service;
}

// ----------------------------------------------------------------------------
// Pure merge / dedup / sort / compare helpers (unit-tested).
// ----------------------------------------------------------------------------

/**
 * A stable dedup key for an event invited to multiple calendars: prefer the
 * join URL (the same Meet/Zoom/Teams link identifies the same meeting across
 * accounts); else fall back to title + start time. Keeps the FIRST seen.
 */
export function dedupeKey(e: CalendarEvent): string {
  if (e.joinUrl) return `url:${e.joinUrl}`;
  return `ts:${e.startsAt}|${e.title.trim().toLowerCase()}`;
}

export function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Map<string, CalendarEvent>();
  for (const e of events) {
    const key = dedupeKey(e);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
    } else if (!existing.meetingId && e.meetingId) {
      // Prefer the copy already linked to a recording.
      seen.set(key, e);
    }
  }
  return [...seen.values()];
}

export function sortSoonestFirst(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    const cmp = a.startsAt.localeCompare(b.startsAt);
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
  });
}

/** Same local calendar day as `ref`. */
export function isSameLocalDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

function isExpired(tokens: CalendarOAuthTokens, nowMs: number): boolean {
  if (!tokens.expiresAt) return false;
  const t = new Date(tokens.expiresAt).getTime();
  return Number.isFinite(t) && t <= nowMs;
}

/** Structural equality over the fields that matter for "the set changed". */
export function eventsEqual(a: CalendarEvent[], b: CalendarEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      x.startsAt !== y.startsAt ||
      x.endsAt !== y.endsAt ||
      x.title !== y.title ||
      x.joinUrl !== y.joinUrl ||
      x.platform !== y.platform ||
      x.meetingId !== y.meetingId
    ) {
      return false;
    }
  }
  return true;
}
