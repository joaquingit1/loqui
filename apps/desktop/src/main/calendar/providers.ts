/**
 * PRD-15 — Calendar provider implementations (main process).
 *
 * Implements the {@link CalendarProvider} seam from types.ts:
 *   - {@link FakeCalendarProvider} — deterministic, hermetic (NO network) for the
 *     unit gate + the `smoke:calendar`. Seeded with a fixed event set + a fixed
 *     connect outcome.
 *   - {@link GoogleProvider} / {@link MicrosoftProvider} / {@link ZoomProvider} —
 *     the three real cloud backends. ALL their HTTP is behind an INJECTABLE
 *     `CalendarHttp` (mirrors the OAuth `OAuthHttp`) + the loopback-PKCE
 *     `runPkceFlow`, so tests mock both and NO real network is touched (the only
 *     permitted real socket is the 127.0.0.1 OAuth redirect listener).
 *
 * NORMALIZATION (the per-provider unit-tested bit): each real provider fetches
 * its raw events for [from, to) and maps them onto the shared {@link CalendarEvent}
 * — extracting the conferencing platform + join link from each provider's own
 * conference-data shape (Google `hangoutLink`/conferenceData, Microsoft Graph
 * `onlineMeeting.joinUrl`, Zoom `join_url`). Pure, exported normalizers
 * (`normalizeGoogleEvent` etc.) keep that mapping unit-testable against fixtures.
 *
 * READ-ONLY: every provider method either runs OAuth or LISTS events — none
 * writes a calendar (no create/update/delete) or a transcript file.
 *
 * App-registration (per provider) — documented here, NEVER a hardcoded secret:
 *   - Google: create a "Desktop app" OAuth client in Google Cloud Console; it is
 *     a PUBLIC client (PKCE, no secret). Set LOQUI_GOOGLE_CLIENT_ID. Scope:
 *     https://www.googleapis.com/auth/calendar.events.readonly.
 *   - Microsoft: register an app in Entra ID as a "Mobile and desktop" (public)
 *     client with the loopback redirect; PKCE, no secret. Set
 *     LOQUI_MS_CLIENT_ID (+ optionally LOQUI_MS_TENANT, default "common").
 *     Scope: Calendars.Read offline_access.
 *   - Zoom: create an OAuth app; Zoom mandates a client secret even for desktop,
 *     so read LOQUI_ZOOM_CLIENT_ID + LOQUI_ZOOM_CLIENT_SECRET from the env
 *     (NEVER committed). Scope: meeting:read.
 */
import {
  calendarEventSchema,
  type CalendarEvent,
  type CalendarPlatform,
  type CalendarSource,
} from "@loqui/shared";
import {
  refreshTokens,
  runPkceFlow,
  type OAuthClientConfig,
  type OAuthHttp,
  type OpenExternal,
} from "./oauth.js";
import type {
  CalendarConnectOutcome,
  CalendarOAuthTokens,
  CalendarProvider,
} from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The slice of the network the real providers depend on (event listing + the
 * "whoami" account lookup), injected so tests mock it. Mirrors the Fetch API; a
 * GET-with-bearer convenience for read-only calls.
 */
export interface CalendarHttp {
  (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

/** Construction deps shared by the real (network-backed) providers. */
export interface RealProviderDeps {
  /** Injected HTTP for event listing (production: a wrapper over global fetch). */
  http: CalendarHttp;
  /** Injected OAuth-endpoint HTTP (token exchange/refresh). */
  oauthHttp: OAuthHttp;
  /** Open the consent page (production: Electron shell.openExternal). */
  openExternal: OpenExternal;
  /** Override clock for deterministic tests. */
  now?: () => number;
}

/** Bearer GET helper that throws on a non-OK response. */
async function getJson(http: CalendarHttp, url: string, accessToken: string): Promise<any> {
  const res = await http(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`calendar list request failed (${res.status})`);
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// FakeCalendarProvider — deterministic, hermetic (no network).
// ----------------------------------------------------------------------------

export interface FakeCalendarProviderOptions {
  source?: CalendarSource;
  /** Account label the fake "connect" links. */
  account?: string;
  /**
   * Event template generator. Receives the connect account + the requested
   * range; returns RAW CalendarEvent-ish objects (parsed/defaulted on the way
   * out). Defaults to a fixed two-event set seeded relative to `now`.
   */
  seed?: (account: string, range: { from: Date; to: Date }) => CalendarEvent[];
  /** Clock for deterministic seeding. */
  now?: () => number;
}

/**
 * A hermetic {@link CalendarProvider} that issues fixed tokens on connect and
 * returns a deterministic, range-clipped event set on listEvents. NO network —
 * connect/disconnect/refresh resolve immediately. Drives the unit gate + smoke.
 */
export class FakeCalendarProvider implements CalendarProvider {
  readonly id: CalendarSource;
  readonly #account: string;
  readonly #seed: NonNullable<FakeCalendarProviderOptions["seed"]>;
  readonly #now: () => number;

  constructor(opts: FakeCalendarProviderOptions = {}) {
    this.id = opts.source ?? "google";
    this.#account = opts.account ?? `${this.id}-user@example.com`;
    this.#now = opts.now ?? Date.now;
    this.#seed = opts.seed ?? ((account, range) => this.#defaultSeed(account, range));
  }

  connect(): Promise<CalendarConnectOutcome> {
    return Promise.resolve({
      account: this.#account,
      tokens: {
        accessToken: `fake-access-${this.id}`,
        refreshToken: `fake-refresh-${this.id}`,
        expiresAt: new Date(this.#now() + 3600_000).toISOString(),
        scope: "calendar.readonly",
      },
    });
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  refreshAccessToken(tokens: CalendarOAuthTokens): Promise<CalendarOAuthTokens> {
    return Promise.resolve({
      ...tokens,
      accessToken: `fake-access-${this.id}-refreshed`,
      expiresAt: new Date(this.#now() + 3600_000).toISOString(),
    });
  }

  listEvents(
    _tokens: CalendarOAuthTokens,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]> {
    const all = this.#seed(account, range);
    // Clip to [from, to) by start time so the fake honors the requested window.
    const out = all.filter((e) => {
      const t = new Date(e.startsAt).getTime();
      return t >= range.from.getTime() && t < range.to.getTime();
    });
    return Promise.resolve(out);
  }

  /** Two fixed events later "today": a Meet at +1h and a Zoom at +3h. */
  #defaultSeed(account: string, _range: { from: Date; to: Date }): CalendarEvent[] {
    const base = this.#now();
    const mk = (offsetMin: number, durMin: number): { startsAt: string; endsAt: string } => ({
      startsAt: new Date(base + offsetMin * 60_000).toISOString(),
      endsAt: new Date(base + (offsetMin + durMin) * 60_000).toISOString(),
    });
    const events: CalendarEvent[] = [
      calendarEventSchema.parse({
        id: `fake-${this.id}-1`,
        title: "Standup",
        ...mk(60, 30),
        platform: "google-meet",
        joinUrl: `https://meet.google.com/abc-${this.id}-hij`,
        attendees: [
          { name: "Alex", email: "alex@example.com" },
          { name: "Sam", email: "sam@example.com" },
        ],
        source: this.id,
        calendarAccount: account,
      }),
      calendarEventSchema.parse({
        id: `fake-${this.id}-2`,
        title: "Design review",
        ...mk(180, 60),
        platform: "zoom",
        joinUrl: `https://zoom.us/j/${this.id}-123456789`,
        attendees: [{ name: "Jordan", email: "jordan@example.com" }],
        source: this.id,
        calendarAccount: account,
      }),
    ];
    return events;
  }
}

// ----------------------------------------------------------------------------
// Shared OAuth driver for the real providers.
// ----------------------------------------------------------------------------

abstract class OAuthCalendarProvider implements CalendarProvider {
  abstract readonly id: CalendarSource;
  protected abstract config(): OAuthClientConfig;
  /** Look up the connected account label (e.g. email) from a fresh access token. */
  protected abstract resolveAccount(accessToken: string): Promise<string>;
  abstract listEvents(
    tokens: CalendarOAuthTokens,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]>;

  protected readonly deps: RealProviderDeps;
  protected readonly now: () => number;

  constructor(deps: RealProviderDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async connect(): Promise<CalendarConnectOutcome> {
    const tokens = await runPkceFlow({
      config: this.config(),
      http: this.deps.oauthHttp,
      openExternal: this.deps.openExternal,
      now: this.now,
    });
    const account = await this.resolveAccount(tokens.accessToken);
    return { account, tokens };
  }

  // Best-effort: the cloud providers' revoke endpoints differ; the service
  // always clears the keystore regardless, so a revoke failure is swallowed.
  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  refreshAccessToken(tokens: CalendarOAuthTokens): Promise<CalendarOAuthTokens> {
    return refreshTokens({
      config: this.config(),
      http: this.deps.oauthHttp,
      tokens,
      nowMs: this.now(),
    });
  }
}

// ----------------------------------------------------------------------------
// Google Calendar.
// ----------------------------------------------------------------------------

/**
 * Extract the platform + join link from a Google Calendar event. Prefers the
 * structured conferenceData entry point; falls back to the legacy `hangoutLink`.
 * Recognizes Meet/Zoom/Teams URLs so a Zoom invite on a Google calendar still
 * resolves to `zoom`.
 */
export function extractGooglePlatform(raw: any): { platform: CalendarPlatform; joinUrl: string | null } {
  const entryPoints: any[] = raw?.conferenceData?.entryPoints ?? [];
  const video = entryPoints.find((e) => e?.entryPointType === "video" && typeof e?.uri === "string");
  const uri: string | null = video?.uri ?? (typeof raw?.hangoutLink === "string" ? raw.hangoutLink : null);
  if (uri) return { platform: platformFromUrl(uri, "google-meet"), joinUrl: uri };
  return { platform: null, joinUrl: null };
}

export function normalizeGoogleEvent(raw: any, account: string): CalendarEvent | null {
  const start: string | undefined = raw?.start?.dateTime ?? raw?.start?.date;
  const end: string | undefined = raw?.end?.dateTime ?? raw?.end?.date;
  if (!start || !end) return null; // all-day with no time / malformed: skip.
  const { platform, joinUrl } = extractGooglePlatform(raw);
  const attendees = (raw?.attendees ?? []).map((a: any) => ({
    name: typeof a?.displayName === "string" ? a.displayName : "",
    email: typeof a?.email === "string" ? a.email : null,
  }));
  return parseEvent({
    id: typeof raw?.id === "string" ? raw.id : "",
    title: typeof raw?.summary === "string" ? raw.summary : "",
    startsAt: toIso(start),
    endsAt: toIso(end),
    platform,
    joinUrl,
    attendees,
    source: "google" as const,
    calendarAccount: account,
  });
}

export class GoogleProvider extends OAuthCalendarProvider {
  readonly id = "google" as const;

  protected config(): OAuthClientConfig {
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: process.env["LOQUI_GOOGLE_CLIENT_ID"] ?? "",
      scope: "https://www.googleapis.com/auth/calendar.events.readonly",
      redirectPath: "/oauth/google",
      // access_type=offline + prompt=consent so Google returns a refresh token.
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    };
  }

  protected async resolveAccount(accessToken: string): Promise<string> {
    const json = await getJson(
      this.deps.http,
      "https://www.googleapis.com/oauth2/v2/userinfo",
      accessToken,
    );
    return typeof json?.email === "string" ? json.email : "google-account";
  }

  async listEvents(
    tokens: CalendarOAuthTokens,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]> {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("timeMin", range.from.toISOString());
    url.searchParams.set("timeMax", range.to.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "100");
    const json = await getJson(this.deps.http, url.toString(), tokens.accessToken);
    const items: any[] = json?.items ?? [];
    return items
      .map((raw) => normalizeGoogleEvent(raw, account))
      .filter((e): e is CalendarEvent => e !== null);
  }
}

// ----------------------------------------------------------------------------
// Microsoft 365 / Outlook (Microsoft Graph).
// ----------------------------------------------------------------------------

export function extractMicrosoftPlatform(raw: any): { platform: CalendarPlatform; joinUrl: string | null } {
  const joinUrl: string | null =
    typeof raw?.onlineMeeting?.joinUrl === "string"
      ? raw.onlineMeeting.joinUrl
      : typeof raw?.onlineMeetingUrl === "string"
        ? raw.onlineMeetingUrl
        : null;
  if (!joinUrl) return { platform: null, joinUrl: null };
  // Graph tags the provider; default Teams for teamsForBusiness.
  const provider: string | undefined = raw?.onlineMeetingProvider;
  if (provider === "teamsForBusiness") return { platform: "teams", joinUrl };
  return { platform: platformFromUrl(joinUrl, "teams"), joinUrl };
}

export function normalizeMicrosoftEvent(raw: any, account: string): CalendarEvent | null {
  const start: string | undefined = raw?.start?.dateTime;
  const end: string | undefined = raw?.end?.dateTime;
  if (!start || !end) return null;
  const { platform, joinUrl } = extractMicrosoftPlatform(raw);
  const attendees = (raw?.attendees ?? []).map((a: any) => ({
    name: typeof a?.emailAddress?.name === "string" ? a.emailAddress.name : "",
    email: typeof a?.emailAddress?.address === "string" ? a.emailAddress.address : null,
  }));
  // Graph dateTimes are UTC without an offset unless a timeZone is given; the
  // service requests UTC (Prefer header), so append Z when no offset is present.
  return parseEvent({
    id: typeof raw?.id === "string" ? raw.id : "",
    title: typeof raw?.subject === "string" ? raw.subject : "",
    startsAt: toIso(start),
    endsAt: toIso(end),
    platform,
    joinUrl,
    attendees,
    source: "microsoft" as const,
    calendarAccount: account,
  });
}

export class MicrosoftProvider extends OAuthCalendarProvider {
  readonly id = "microsoft" as const;

  protected config(): OAuthClientConfig {
    const tenant = process.env["LOQUI_MS_TENANT"] ?? "common";
    return {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      clientId: process.env["LOQUI_MS_CLIENT_ID"] ?? "",
      scope: "Calendars.Read offline_access openid email",
      redirectPath: "/oauth/microsoft",
    };
  }

  protected async resolveAccount(accessToken: string): Promise<string> {
    const json = await getJson(this.deps.http, "https://graph.microsoft.com/v1.0/me", accessToken);
    return (
      (typeof json?.mail === "string" && json.mail) ||
      (typeof json?.userPrincipalName === "string" && json.userPrincipalName) ||
      "microsoft-account"
    );
  }

  async listEvents(
    tokens: CalendarOAuthTokens,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]> {
    const url = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
    url.searchParams.set("startDateTime", range.from.toISOString());
    url.searchParams.set("endDateTime", range.to.toISOString());
    url.searchParams.set("$orderby", "start/dateTime");
    url.searchParams.set("$top", "100");
    const res = await this.deps.http(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
        // Ask Graph for UTC so the dateTimes carry a known zone.
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (!res.ok) throw new Error(`calendar list request failed (${res.status})`);
    const json: any = await res.json();
    const items: any[] = json?.value ?? [];
    return items
      .map((raw) => normalizeMicrosoftEvent(raw, account))
      .filter((e): e is CalendarEvent => e !== null);
  }
}

// ----------------------------------------------------------------------------
// Zoom.
// ----------------------------------------------------------------------------

export function normalizeZoomEvent(raw: any, account: string): CalendarEvent | null {
  const start: string | undefined = raw?.start_time;
  if (!start) return null;
  const durationMin: number = typeof raw?.duration === "number" ? raw.duration : 30;
  const startDate = new Date(start);
  const endsAt = new Date(startDate.getTime() + durationMin * 60_000).toISOString();
  const joinUrl: string | null = typeof raw?.join_url === "string" ? raw.join_url : null;
  return parseEvent({
    id: raw?.id !== undefined ? String(raw.id) : "",
    title: typeof raw?.topic === "string" ? raw.topic : "",
    startsAt: toIso(start),
    endsAt,
    platform: "zoom" as const,
    joinUrl,
    attendees: [],
    source: "zoom" as const,
    calendarAccount: account,
  });
}

export class ZoomProvider extends OAuthCalendarProvider {
  readonly id = "zoom" as const;

  protected config(): OAuthClientConfig {
    return {
      authorizeUrl: "https://zoom.us/oauth/authorize",
      tokenUrl: "https://zoom.us/oauth/token",
      clientId: process.env["LOQUI_ZOOM_CLIENT_ID"] ?? "",
      // Zoom mandates a client secret even for desktop; read from env, never hardcoded.
      clientSecret: process.env["LOQUI_ZOOM_CLIENT_SECRET"],
      scope: "meeting:read",
      redirectPath: "/oauth/zoom",
    };
  }

  protected async resolveAccount(accessToken: string): Promise<string> {
    const json = await getJson(this.deps.http, "https://api.zoom.us/v2/users/me", accessToken);
    return typeof json?.email === "string" ? json.email : "zoom-account";
  }

  async listEvents(
    tokens: CalendarOAuthTokens,
    account: string,
    range: { from: Date; to: Date },
  ): Promise<CalendarEvent[]> {
    // Zoom lists scheduled meetings (no server-side date range); clip locally.
    const json = await getJson(
      this.deps.http,
      "https://api.zoom.us/v2/users/me/meetings?type=scheduled&page_size=100",
      tokens.accessToken,
    );
    const items: any[] = json?.meetings ?? [];
    return items
      .map((raw) => normalizeZoomEvent(raw, account))
      .filter((e): e is CalendarEvent => e !== null)
      .filter((e) => {
        const t = new Date(e.startsAt).getTime();
        return t >= range.from.getTime() && t < range.to.getTime();
      });
  }
}

// ----------------------------------------------------------------------------
// Shared helpers.
// ----------------------------------------------------------------------------

/** Recognize a conferencing platform from a join URL; fall back to `fallback`. */
export function platformFromUrl(url: string, fallback: NonNullable<CalendarPlatform>): CalendarPlatform {
  const u = url.toLowerCase();
  if (u.includes("meet.google.com")) return "google-meet";
  if (u.includes("zoom.us") || u.includes("zoom.com")) return "zoom";
  if (u.includes("teams.microsoft.com") || u.includes("teams.live.com")) return "teams";
  return fallback;
}

/** Normalize a date-only or dateTime string to an ISO-8601 with offset. */
function toIso(value: string): string {
  // Already has a zone designator (Z or ±hh:mm)?
  if (/[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value).toISOString();
  // A bare date ("2026-06-24") or a zone-less dateTime — treat as UTC.
  const d = new Date(/\d{2}:\d{2}/.test(value) ? `${value}Z` : value);
  return d.toISOString();
}

/** Parse + default a raw normalized event; returns null if it fails validation. */
function parseEvent(raw: unknown): CalendarEvent | null {
  const parsed = calendarEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
