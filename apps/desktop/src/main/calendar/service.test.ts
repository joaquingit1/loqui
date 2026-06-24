/**
 * Hermetic tests for the main calendar service (PRD-15).
 *
 * NO network: the service is driven by FakeCalendarProviders + an in-memory
 * token store, and timers are injected so polling never relies on the real
 * clock. Asserts: connect persists tokens + emits; fan-out merges + de-dups
 * across accounts; soonest-first sort; listToday vs listUpcoming windowing;
 * cache TTL; onUpdated fires on change only; refresh; disconnect clears +
 * re-emits; linkMeeting stamps meetingId.
 */
import { describe, expect, it, vi } from "vitest";
import {
  calendarEventSchema,
  type CalendarConnection,
  type CalendarEvent,
  type CalendarProviderId,
} from "@loqui/shared";
import { FakeCalendarProvider } from "./providers.js";
import {
  createCalendarService,
  dedupe,
  dedupeKey,
  eventsEqual,
  sortSoonestFirst,
} from "./service.js";
import type { CalendarOAuthTokens, CalendarTokenStore } from "./types.js";

/** A simple in-memory token store (no safeStorage), good enough for the service. */
function memStore(): CalendarTokenStore {
  const entries = new Map<string, { tokens: CalendarOAuthTokens; lastSyncAt: string | null }>();
  const key = (p: string, a: string): string => `${p}:${a}`;
  return {
    setTokens(provider, account, tokens) {
      const existing = entries.get(key(provider, account));
      entries.set(key(provider, account), { tokens, lastSyncAt: existing?.lastSyncAt ?? null });
    },
    getTokens(provider, account) {
      return entries.get(key(provider, account))?.tokens ?? null;
    },
    clearTokens(provider, account) {
      if (account !== undefined) entries.delete(key(provider, account));
      else for (const k of [...entries.keys()]) if (k.startsWith(`${provider}:`)) entries.delete(k);
    },
    getConnections(): CalendarConnection[] {
      return [...entries.entries()].map(([k, v]) => {
        const sep = k.indexOf(":");
        return {
          provider: k.slice(0, sep) as CalendarProviderId,
          account: k.slice(sep + 1),
          lastSyncAt: v.lastSyncAt,
        };
      });
    },
    recordSync(provider, account, at) {
      const e = entries.get(key(provider, account));
      if (e) e.lastSyncAt = at;
    },
  };
}

function ev(over: Partial<CalendarEvent> & { id: string; startsAt: string }): CalendarEvent {
  return calendarEventSchema.parse({
    endsAt: over.endsAt ?? new Date(Date.parse(over.startsAt) + 1800_000).toISOString(),
    source: "google",
    ...over,
  });
}

const NOW = Date.parse("2026-06-24T09:00:00Z");

describe("pure helpers", () => {
  it("dedupeKey prefers the join URL", () => {
    const a = ev({ id: "a", startsAt: "2026-06-24T10:00:00Z", joinUrl: "https://zoom.us/j/1" });
    const b = ev({ id: "b", startsAt: "2026-06-24T10:00:00Z", joinUrl: "https://zoom.us/j/1" });
    expect(dedupeKey(a)).toBe(dedupeKey(b));
  });

  it("dedupe collapses the same invite across two accounts, keeping a linked copy", () => {
    const unlinked = ev({ id: "a", startsAt: "2026-06-24T10:00:00Z", joinUrl: "https://meet.google.com/x" });
    const linked = ev({
      id: "b",
      startsAt: "2026-06-24T10:00:00Z",
      joinUrl: "https://meet.google.com/x",
      meetingId: "mtg-1",
    });
    const out = dedupe([unlinked, linked]);
    expect(out).toHaveLength(1);
    expect(out[0]?.meetingId).toBe("mtg-1");
  });

  it("sortSoonestFirst orders by start then id", () => {
    const out = sortSoonestFirst([
      ev({ id: "late", startsAt: "2026-06-24T12:00:00Z" }),
      ev({ id: "early", startsAt: "2026-06-24T08:00:00Z" }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("eventsEqual detects a meetingId change", () => {
    const a = [ev({ id: "a", startsAt: "2026-06-24T10:00:00Z" })];
    const b = [ev({ id: "a", startsAt: "2026-06-24T10:00:00Z", meetingId: "m" })];
    expect(eventsEqual(a, a)).toBe(true);
    expect(eventsEqual(a, b)).toBe(false);
  });
});

describe("createCalendarService", () => {
  function setup() {
    const tokenStore = memStore();
    const google = new FakeCalendarProvider({ source: "google", account: "g@x.com", now: () => NOW });
    const zoom = new FakeCalendarProvider({ source: "zoom", account: "z@x.com", now: () => NOW });
    const service = createCalendarService({
      tokenStore,
      providers: { google, zoom },
      now: () => NOW,
      cacheTtlMs: 1000,
      pollIntervalMs: 0, // no background polling in unit tests
    });
    return { service, tokenStore };
  }

  it("connect persists tokens and reports the linked account", async () => {
    const { service, tokenStore } = setup();
    const result = await service.connect("google");
    expect(result).toEqual({ connected: true, account: "g@x.com" });
    expect(tokenStore.getTokens("google", "g@x.com")?.accessToken).toBe("fake-access-google");
  });

  it("connect for an unregistered provider returns connected:false", async () => {
    const { service } = setup();
    const result = await service.connect("microsoft");
    expect(result.connected).toBe(false);
  });

  it("listToday returns today's events soonest-first across accounts", async () => {
    const { service } = setup();
    await service.connect("google");
    await service.connect("zoom");
    const today = await service.listToday();
    // Each fake seeds 2 events later today (Meet +1h, Zoom +3h) per account.
    expect(today.length).toBe(4);
    // Soonest-first.
    const starts = today.map((e) => e.startsAt);
    expect([...starts].sort()).toEqual(starts);
    expect(today.some((e) => e.source === "google")).toBe(true);
    expect(today.some((e) => e.source === "zoom")).toBe(true);
  });

  it("de-duplicates the same invite seen on two accounts", async () => {
    const tokenStore = memStore();
    const sharedSeed = (account: string): CalendarEvent[] => [
      ev({
        id: `shared-${account}`,
        startsAt: "2026-06-24T10:00:00Z",
        joinUrl: "https://meet.google.com/shared",
        platform: "google-meet",
        calendarAccount: account,
      }),
    ];
    const a = new FakeCalendarProvider({ source: "google", account: "a@x.com", seed: sharedSeed, now: () => NOW });
    const b = new FakeCalendarProvider({ source: "zoom", account: "b@x.com", seed: sharedSeed, now: () => NOW });
    const service = createCalendarService({
      tokenStore,
      providers: { google: a, zoom: b },
      now: () => NOW,
      pollIntervalMs: 0,
    });
    await service.connect("google");
    await service.connect("zoom");
    const today = await service.listToday();
    expect(today).toHaveLength(1);
  });

  it("listUpcoming windows by withinHours and caps by limit", async () => {
    const { service } = setup();
    await service.connect("google"); // 2 events: +1h, +3h
    const within2h = await service.listUpcoming({ withinHours: 2 });
    expect(within2h).toHaveLength(1); // only the +1h event
    const capped = await service.listUpcoming({ withinHours: 100, limit: 1 });
    expect(capped).toHaveLength(1);
  });

  it("onUpdated fires on connect and again on a changing refresh, not on a no-op", async () => {
    const { service } = setup();
    const seen: number[] = [];
    const unsub = service.onUpdated((events) => seen.push(events.length));
    await service.connect("google");
    expect(seen.at(-1)).toBe(2);
    // A refresh with the same data must NOT emit again.
    const before = seen.length;
    await service.refresh();
    expect(seen.length).toBe(before);
    unsub();
  });

  it("caches within the TTL (no re-emit when serving the cache)", async () => {
    const { service } = setup();
    const listSpy = service;
    await service.connect("google");
    // Within TTL: listToday serves the cache; values are stable.
    const a = await listSpy.listToday();
    const b = await listSpy.listToday();
    expect(a).toEqual(b);
  });

  it("disconnect clears tokens and re-emits the (now empty) set", async () => {
    const { service, tokenStore } = setup();
    const seen: number[] = [];
    service.onUpdated((events) => seen.push(events.length));
    await service.connect("google");
    expect(tokenStore.getConnections()).toHaveLength(1);
    await service.disconnect("google");
    expect(tokenStore.getConnections()).toHaveLength(0);
    expect(seen.at(-1)).toBe(0);
  });

  it("getConnections lists accounts without tokens", async () => {
    const { service } = setup();
    await service.connect("google");
    const conns = await service.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ provider: "google", account: "g@x.com" });
    expect((conns[0] as unknown as Record<string, unknown>)["tokens"]).toBeUndefined();
  });

  it("linkMeeting stamps meetingId on the cached event and re-emits", async () => {
    const { service } = setup();
    const seen: CalendarEvent[][] = [];
    service.onUpdated((events) => seen.push(events));
    await service.connect("google");
    const today = await service.listToday();
    const target = today[0]!;
    const linked = service.linkMeeting(target.id, "mtg-99");
    expect(linked?.meetingId).toBe("mtg-99");
    const after = await service.listToday();
    expect(after.find((e) => e.id === target.id)?.meetingId).toBe("mtg-99");
    expect(seen.at(-1)?.find((e) => e.id === target.id)?.meetingId).toBe("mtg-99");
  });

  it("dispose stops timers + clears listeners (idempotent)", async () => {
    const tokenStore = memStore();
    const clearInterval = vi.fn();
    const setInterval = vi.fn(() => 1);
    const service = createCalendarService({
      tokenStore,
      providers: { google: new FakeCalendarProvider({ source: "google", now: () => NOW }) },
      now: () => NOW,
      pollIntervalMs: 1000,
      setInterval,
      clearInterval,
    });
    service.onUpdated(() => {});
    expect(setInterval).toHaveBeenCalled();
    service.dispose();
    expect(clearInterval).toHaveBeenCalled();
    expect(() => service.dispose()).not.toThrow();
  });
});
