/**
 * Hermetic tests for the calendar provider implementations (PRD-15).
 *
 * NO real network: the FakeCalendarProvider is offline by construction, and the
 * real providers' HTTP + OAuth are driven through INJECTED stubs (a fake
 * CalendarHttp / OAuthHttp + a no-op openExternal). The per-provider normalizers
 * are exercised against fixture payloads (Google conferenceData / hangoutLink,
 * Microsoft Graph onlineMeeting.joinUrl, Zoom join_url) and the platform/link
 * extraction is asserted.
 */
import { describe, expect, it, vi } from "vitest";
import type { CalendarOAuthTokens } from "./types.js";
import {
  FakeCalendarProvider,
  GoogleProvider,
  MicrosoftProvider,
  ZoomProvider,
  extractGooglePlatform,
  extractMicrosoftPlatform,
  normalizeGoogleEvent,
  normalizeMicrosoftEvent,
  normalizeZoomEvent,
  platformFromUrl,
  type CalendarHttp,
} from "./providers.js";
import type { OAuthHttp } from "./oauth.js";

/** A CalendarHttp that returns a fixed JSON body for any URL (asserts no real net). */
function jsonHttp(body: unknown, ok = true, status = 200): CalendarHttp & { urls: string[] } {
  const urls: string[] = [];
  const fn: CalendarHttp = (url: string) => {
    urls.push(url);
    return Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  };
  return Object.assign(fn, { urls });
}

const TOKENS: CalendarOAuthTokens = {
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: null,
  scope: null,
};
const RANGE = { from: new Date("2026-06-24T00:00:00Z"), to: new Date("2026-06-25T00:00:00Z") };

describe("platformFromUrl", () => {
  it("recognizes Meet/Zoom/Teams URLs", () => {
    expect(platformFromUrl("https://meet.google.com/abc", "other")).toBe("google-meet");
    expect(platformFromUrl("https://zoom.us/j/1", "other")).toBe("zoom");
    expect(platformFromUrl("https://teams.microsoft.com/l/x", "other")).toBe("teams");
    expect(platformFromUrl("https://example.com/x", "teams")).toBe("teams");
  });
});

describe("FakeCalendarProvider", () => {
  it("connects with deterministic tokens + an account, never touching the network", async () => {
    const p = new FakeCalendarProvider({ source: "google", now: () => 0 });
    const out = await p.connect();
    expect(out.account).toBe("google-user@example.com");
    expect(out.tokens.accessToken).toBe("fake-access-google");
    expect(out.tokens.refreshToken).toBe("fake-refresh-google");
  });

  it("lists a fixed event set clipped to the requested range, soonest-first capable", async () => {
    const base = Date.parse("2026-06-24T09:00:00Z");
    const p = new FakeCalendarProvider({ source: "google", now: () => base });
    const events = await p.listEvents(TOKENS, "acct@example.com", {
      from: new Date(base),
      to: new Date(base + 24 * 3600_000),
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.platform).toBe("google-meet");
    expect(events[0]?.joinUrl).toContain("meet.google.com");
    expect(events[1]?.platform).toBe("zoom");
    expect(events.every((e) => e.calendarAccount === "acct@example.com")).toBe(true);
    expect(events.every((e) => e.source === "google")).toBe(true);
  });

  it("clips out events outside the range", async () => {
    const base = Date.parse("2026-06-24T09:00:00Z");
    const p = new FakeCalendarProvider({ source: "zoom", now: () => base });
    // Window ends before the +3h event -> only the +1h event survives.
    const events = await p.listEvents(TOKENS, "z@example.com", {
      from: new Date(base),
      to: new Date(base + 2 * 3600_000),
    });
    expect(events).toHaveLength(1);
  });

  it("honors a custom seed", async () => {
    const p = new FakeCalendarProvider({
      source: "microsoft",
      seed: () => [],
    });
    const events = await p.listEvents(TOKENS, "m@example.com", RANGE);
    expect(events).toEqual([]);
  });
});

describe("Google normalization", () => {
  it("extracts the Meet link from conferenceData entry points", () => {
    const { platform, joinUrl } = extractGooglePlatform({
      conferenceData: {
        entryPoints: [
          { entryPointType: "more", uri: "https://meet.google.com/x/extra" },
          { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
        ],
      },
    });
    expect(platform).toBe("google-meet");
    expect(joinUrl).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("falls back to the legacy hangoutLink", () => {
    const { platform, joinUrl } = extractGooglePlatform({
      hangoutLink: "https://meet.google.com/legacy",
    });
    expect(platform).toBe("google-meet");
    expect(joinUrl).toBe("https://meet.google.com/legacy");
  });

  it("resolves a Zoom link on a Google event to platform zoom", () => {
    const { platform } = extractGooglePlatform({
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/5" }] },
    });
    expect(platform).toBe("zoom");
  });

  it("normalizes a full Google event with attendees", () => {
    const e = normalizeGoogleEvent(
      {
        id: "g1",
        summary: "Sprint planning",
        start: { dateTime: "2026-06-24T10:00:00Z" },
        end: { dateTime: "2026-06-24T11:00:00Z" },
        hangoutLink: "https://meet.google.com/p",
        attendees: [
          { displayName: "Alex", email: "alex@example.com" },
          { email: "bot@example.com" },
        ],
      },
      "me@example.com",
    );
    expect(e).not.toBeNull();
    expect(e?.title).toBe("Sprint planning");
    expect(e?.platform).toBe("google-meet");
    expect(e?.source).toBe("google");
    expect(e?.attendees).toEqual([
      { name: "Alex", email: "alex@example.com" },
      { name: "", email: "bot@example.com" },
    ]);
    expect(e?.meetingId).toBeNull();
  });

  it("skips an event with no start/end time", () => {
    expect(normalizeGoogleEvent({ id: "g2", summary: "All day" }, "me")).toBeNull();
  });

  it("listEvents requests the calendar window + normalizes the items", async () => {
    const http = jsonHttp({
      items: [
        {
          id: "g1",
          summary: "Standup",
          start: { dateTime: "2026-06-24T09:00:00Z" },
          end: { dateTime: "2026-06-24T09:15:00Z" },
          hangoutLink: "https://meet.google.com/s",
        },
      ],
    });
    const p = new GoogleProvider({
      http,
      oauthHttp: (() => Promise.reject(new Error("no oauth in this test"))) as OAuthHttp,
      openExternal: () => Promise.resolve(),
    });
    const events = await p.listEvents(TOKENS, "me@example.com", RANGE);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Standup");
    // The request hit Google's events endpoint with timeMin/timeMax.
    expect(http.urls[0]).toContain("calendar/v3/calendars/primary/events");
    expect(http.urls[0]).toContain("timeMin=");
  });
});

describe("Microsoft normalization", () => {
  it("extracts the Teams join link from onlineMeeting", () => {
    const { platform, joinUrl } = extractMicrosoftPlatform({
      onlineMeetingProvider: "teamsForBusiness",
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup/x" },
    });
    expect(platform).toBe("teams");
    expect(joinUrl).toContain("teams.microsoft.com");
  });

  it("normalizes a Graph event", () => {
    const e = normalizeMicrosoftEvent(
      {
        id: "m1",
        subject: "1:1",
        start: { dateTime: "2026-06-24T14:00:00.0000000", timeZone: "UTC" },
        end: { dateTime: "2026-06-24T14:30:00.0000000", timeZone: "UTC" },
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/x" },
        attendees: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }],
      },
      "me@contoso.com",
    );
    expect(e?.title).toBe("1:1");
    expect(e?.platform).toBe("teams");
    expect(e?.source).toBe("microsoft");
    expect(e?.attendees[0]).toEqual({ name: "Sam", email: "sam@example.com" });
    // The zone-less Graph dateTime is treated as UTC.
    expect(e?.startsAt).toBe("2026-06-24T14:00:00.000Z");
  });

  it("normalizes an event with no online meeting to platform null", () => {
    const e = normalizeMicrosoftEvent(
      {
        id: "m2",
        subject: "Lunch",
        start: { dateTime: "2026-06-24T12:00:00.0000000" },
        end: { dateTime: "2026-06-24T13:00:00.0000000" },
      },
      "me",
    );
    expect(e?.platform).toBeNull();
    expect(e?.joinUrl).toBeNull();
  });

  it("listEvents requests calendarView with a UTC Prefer header", async () => {
    const http = vi.fn((_url: string, _init: { headers: Record<string, string> }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ value: [] }),
        text: () => Promise.resolve("{}"),
      }),
    );
    const p = new MicrosoftProvider({
      http: http as unknown as CalendarHttp,
      oauthHttp: (() => Promise.reject(new Error("no"))) as OAuthHttp,
      openExternal: () => Promise.resolve(),
    });
    await p.listEvents(TOKENS, "me@contoso.com", RANGE);
    expect(http).toHaveBeenCalled();
    const [url, init] = http.mock.calls[0]!;
    expect(url).toContain("me/calendarView");
    expect(init.headers["Prefer"]).toContain("UTC");
  });
});

describe("Zoom normalization", () => {
  it("derives endsAt from duration + carries the join_url", () => {
    const e = normalizeZoomEvent(
      { id: 98765, topic: "Demo", start_time: "2026-06-24T16:00:00Z", duration: 45, join_url: "https://zoom.us/j/98765" },
      "z@example.com",
    );
    expect(e?.id).toBe("98765");
    expect(e?.title).toBe("Demo");
    expect(e?.platform).toBe("zoom");
    expect(e?.joinUrl).toBe("https://zoom.us/j/98765");
    expect(e?.startsAt).toBe("2026-06-24T16:00:00.000Z");
    expect(e?.endsAt).toBe("2026-06-24T16:45:00.000Z");
  });

  it("skips a meeting with no start_time", () => {
    expect(normalizeZoomEvent({ id: 1, topic: "x" }, "z")).toBeNull();
  });

  it("listEvents clips to the requested range", async () => {
    const http = jsonHttp({
      meetings: [
        { id: 1, topic: "In window", start_time: "2026-06-24T10:00:00Z", duration: 30, join_url: "https://zoom.us/j/1" },
        { id: 2, topic: "Out of window", start_time: "2026-07-01T10:00:00Z", duration: 30, join_url: "https://zoom.us/j/2" },
      ],
    });
    const p = new ZoomProvider({
      http,
      oauthHttp: (() => Promise.reject(new Error("no"))) as OAuthHttp,
      openExternal: () => Promise.resolve(),
    });
    const events = await p.listEvents(TOKENS, "z@example.com", RANGE);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("In window");
  });
});

describe("real provider connect (OAuth via injected http, no network)", () => {
  it("Google connect exchanges the code + resolves the account email", async () => {
    // openExternal triggers the (already-bound) redirect; we simulate by hitting
    // the loopback URL the flow opens.
    const oauthHttp: OAuthHttp = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "s" }),
        text: () => Promise.resolve("{}"),
      });
    const userHttp = jsonHttp({ email: "me@gmail.com" });
    const openExternal = (url: string): Promise<void> => {
      // Drive the loopback redirect with the state the authorize URL carries.
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirectUri = u.searchParams.get("redirect_uri")!;
      void fetch(`${redirectUri}?code=AUTHCODE&state=${state}`).catch(() => {});
      return Promise.resolve();
    };
    const p = new GoogleProvider({ http: userHttp, oauthHttp, openExternal });
    const out = await p.connect();
    expect(out.tokens.accessToken).toBe("AT");
    expect(out.account).toBe("me@gmail.com");
  });
});
