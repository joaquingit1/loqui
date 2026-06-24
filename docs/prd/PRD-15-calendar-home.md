# PRD-15 — Calendar Integration + Home / "Today" View

## Goal
Give Loqui a **Home view** that shows the user's **meetings scheduled for today (and upcoming soon)** — pulled from their **Google Calendar, Microsoft 365 / Outlook, and Zoom** accounts — each with its join link (Google Meet / Teams / Zoom), so the user can see what's next and one-click join/record. This is distinct from PRD-6 (in-call speaker-name scraping) and PRD-11 (detecting a call happening *now*): PRD-15 reads **scheduled** events ahead of time.

## Background
Today a `Meeting` record only exists once recording **starts** (`status: recording|processing|done|error`), and the only browseable surface is the dated **Library** of *past* meetings (PRD-3). There is no notion of a *future/scheduled* meeting and nothing reads a calendar. Users expect a home screen that answers "what meetings do I have today, and let me record them." That requires a calendar data source — a new model and a new `window.loqui.calendar` API — feeding a Home view, and (optionally) wiring scheduled events into the PRD-11 auto-record policy ("auto-start when my 2pm Meet begins").

## Scope / deliverables

### Calendar providers (read-only calendar scope)
- A pluggable **`CalendarProvider`** interface (mirroring the PRD-4 `ChatProvider` pattern) with three real backends + a fake:
  - **Google Calendar** — OAuth 2.0 (PKCE, loopback redirect), `calendar.events.readonly` scope; read events + extract the Meet `hangoutLink`/conference data.
  - **Microsoft 365 / Outlook** — Microsoft Graph OAuth (`Calendars.Read`); read events + Teams `onlineMeeting.joinUrl`.
  - **Zoom** — Zoom OAuth (`meeting:read`); list scheduled meetings + join URLs.
  - **`FakeCalendarProvider`** — deterministic, hermetic (no network) for the unit gate + a `smoke:calendar`.
- **OAuth connect flow** driven from the renderer: `connect(provider)` opens the system browser to the provider consent screen, captures the redirect on a loopback port, exchanges the code, and stores **refresh/access tokens in the OS keychain** (Electron `safeStorage`, same keystore as PRD-4 BYOK keys / PRD-5 HF token). Tokens never leave the machine except in calls to the provider; nothing is sent to any Loqui server (there is none).
- **Connection management**: list connected accounts, disconnect (clears keychain tokens), token refresh handled transparently in main.

### Data model (`@loqui/shared`)
- A **`CalendarEvent`** model (zod + emitted JSON Schema), additive and defaulted:
  - `id`, `title`, `startsAt`/`endsAt` (ISO 8601), `platform` (`google-meet|zoom|teams|other|null`), `joinUrl` (string|null), `attendees` (`{name, email|null}[]`), `source` (`google|microsoft|zoom`), `calendarAccount` (which connected account), `meetingId` (string|null — linked once a recording for this event exists).
- Query/param shapes: `ListUpcomingParams {withinHours?, limit?}`, connection status shapes, OAuth-start/-status shapes.

### Main process
- A **calendar service**: per-provider client, normalize provider events → `CalendarEvent[]`, merge + de-duplicate across accounts (same event invited to two calendars), sort soonest-first, cache with a short TTL + manual refresh, and emit a `calendar:updated` push when the set changes (poll on an interval + on focus).
- **IPC + preload**: a `window.loqui.calendar` namespace (see contract below).
- **Event ↔ recording linking**: when a meeting is started while a calendar event is current, pre-fill `Meeting.title`/`platform`/`participants` from the event and set `CalendarEvent.meetingId`; expose "join & record" (open `joinUrl` + `startMeeting`).

### Renderer — Home view
- A **Home screen** (the app's landing view; the current single-screen layout becomes Home + a Library route) showing: **Today's meetings** (soonest-first, with time, platform icon, attendees, join button) and a small **Upcoming** peek; an empty/connect state when no calendar is connected; a **Library** entry point for past meetings (the existing `library.listMeetings`).
- A **Calendar settings** panel: connect/disconnect Google / Microsoft / Zoom, show connected accounts + last-sync, and an explainer of the read-only scope. Actually mounted (no dead UI).
- A **"join & record"** action on a today's-event row (opens join link + starts a meeting linked to the event).

### Auto-record tie-in (light)
- Expose today's events to the PRD-11 detector so a scheduled event can trigger the "ask/auto" record prompt when it begins (PRD-11 consumes; PRD-15 only provides the signal). Fully optional/behind the PRD-11 setting.

## `window.loqui.calendar` contract (the seam the frontend builds against)
```ts
interface LoquiCalendarApi {
  listToday(): Promise<CalendarEvent[]>;                          // today's events, soonest-first
  listUpcoming(params?: { withinHours?: number; limit?: number }): Promise<CalendarEvent[]>;
  connect(provider: "google" | "microsoft" | "zoom"): Promise<{ connected: boolean; account?: string }>;
  disconnect(provider: "google" | "microsoft" | "zoom", account?: string): Promise<void>;
  getConnections(): Promise<{ provider: "google" | "microsoft" | "zoom"; account: string; lastSyncAt: string | null }[]>;
  refresh(): Promise<CalendarEvent[]>;                            // force a re-sync
  onUpdated(cb: (events: CalendarEvent[]) => void): () => void;   // push when the event set changes
}
```

## Out of scope
- Creating/editing/deleting calendar events (read-only). No calendar **write**.
- The actual auto-record state machine (PRD-11) — PRD-15 only feeds it event data.
- Local OS calendar (EventKit / Windows) — deliberately deferred; the three cloud providers cover the target accounts. Keep the `CalendarProvider` interface open so a `local` backend can be added later.

## Acceptance criteria
1. A user can connect a **Google**, **Microsoft 365**, and **Zoom** account via an in-app OAuth flow; tokens are stored in the OS keychain and never logged; disconnect clears them.
2. The Home view lists **today's** scheduled meetings (soonest-first) across all connected accounts, de-duplicated, each with the correct platform + join link; an empty/connect state shows when nothing is connected.
3. "Join & record" on a today's event opens the join link and starts a meeting pre-filled (title/platform/attendees) and linked to the event (`meetingId` set).
4. The event set refreshes on an interval + manual refresh, and `onUpdated` fires when it changes.
5. The "previous meetings" Library is reachable from Home and unchanged (PRD-3).
6. **Hermetic tests**: a `FakeCalendarProvider` drives list/today/upcoming; provider→`CalendarEvent` normalization (Meet/Teams/Zoom link extraction) is unit-tested per provider against fixture payloads; de-dup + sort logic; OAuth token store/clear via a mocked keystore; the Home view renders today/upcoming/empty/connect states; "join & record" wiring. A new `smoke:calendar` drives `connect (fake)` → `listToday` → "join & record" → a linked meeting in the store. **No real network in tests** — provider HTTP is behind the injectable interface.
7. PRD-0..14 stay green; `transcript.live.md` remains untouched (calendar never writes a transcript). Additive + defaulted models; no breaking changes to `Meeting`.

## Notes for implementers
- OAuth: use **loopback-redirect PKCE** (no client secret shipped where avoidable; for providers that require a secret, document the app-registration step and keep the secret out of the repo). The browser opens via `shell.openExternal`; main runs a one-shot loopback listener for the redirect.
- Privacy posture: request the **narrowest read-only calendar scope** each provider offers; surface exactly what's accessed in the connect UI. This is the one feature that intentionally talks to a cloud API — keep it isolated behind `CalendarProvider`, opt-in, and disconnectable.
- Reuse the PRD-4/5 `safeStorage` keystore for tokens (one keychain abstraction for BYOK keys, HF token, and OAuth tokens).
- Keep `CalendarProvider` + the normalizer pure/injectable so the whole feature is testable without network, exactly like the `ChatProvider`/`DiarizationBackend` patterns.
- The Home/Library split: introduce a minimal renderer route/view switch (Home ↔ Library ↔ active Meeting) — the frontend engineer owns the navigation shell; this PRD provides the calendar data + settings.
