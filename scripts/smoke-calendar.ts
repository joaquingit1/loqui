#!/usr/bin/env tsx
/**
 * PRD-15 calendar Home/"Today" smoke body (run via scripts/smoke-calendar.mjs
 * under tsx). NO Electron, NO network, no model, no OAuth socket.
 *
 * Wires the REAL main-process PRD-15 modules together and drives the full
 * "connect → today → join & record → linked meeting in the Library" flow with a
 * hermetic FakeCalendarProvider injected (so no provider HTTP and no OAuth
 * loopback listener ever runs):
 *
 *   createCalendarService({ tokenStore: CalendarKeystore(fakeSafeStorage),
 *                           providers: { google: Fake, zoom: Fake } })
 *     -> connect(google) + connect(zoom)   (persists tokens in the keystore file)
 *     -> listToday()                        (merged, de-duped, soonest-first)
 *     -> openStore().createMeeting(...)     (the REAL meeting store: "join & record")
 *     -> service.linkMeeting(eventId, id)   (CalendarEvent.meetingId set)
 *
 * Asserts (exits non-zero on the first failure):
 *   1. connect persists each account's tokens to calendar-tokens.json (encrypted
 *      — the refresh token never lands plaintext).
 *   2. listToday returns the seeded events soonest-first, each with the right
 *      platform + joinUrl, across BOTH connected accounts.
 *   3. de-dup: the SAME invite seen on two accounts collapses to one event.
 *   4. "join & record" creates a meeting (REAL store) pre-filled from the event,
 *      links it (meetingId set on the cached event), and it shows in listMeetings.
 *   5. READ-ONLY: NO calendar file is written beyond calendar-tokens.json, and
 *      NO transcript.live.md is ever created for the linked meeting (calendar
 *      never writes a transcript). A pre-existing transcript stays byte-identical.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DESKTOP = join(REPO_ROOT, "apps/desktop");

// @loqui/shared isn't link-resolvable from repo-root scripts/, so import its
// built dist by absolute path (same pattern as the other smoke harnesses). The
// desktop main modules below resolve their own @loqui/shared from within
// apps/desktop where it IS linked.
const shared = (await import(
  new URL(`file://${join(REPO_ROOT, "packages/shared/dist/index.js")}`).href
)) as typeof import("@loqui/shared");
const { calendarEventSchema } = shared;

// REAL main-process PRD-15 + store modules (TS source, run under tsx). Import
// the leaf modules directly (NOT the calendar barrel) so we never pull in
// register.ts, which imports electron's ipcMain (unavailable outside Electron).
const { createCalendarService } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/calendar/service.ts")}`).href
)) as typeof import("../apps/desktop/src/main/calendar/service.js");
const { FakeCalendarProvider } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/calendar/providers.ts")}`).href
)) as typeof import("../apps/desktop/src/main/calendar/providers.js");
const { CalendarKeystore } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/calendar/token-store.ts")}`).href
)) as typeof import("../apps/desktop/src/main/calendar/token-store.js");

const { openStore, meetingMetaPath, meetingLiveTranscriptPath } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/store/index.ts")}`).href
)) as typeof import("../apps/desktop/src/main/store/index.js");

type SafeStorageLike = import("../apps/desktop/src/main/calendar/types.js").SafeStorageLike;
type CalendarEvent = import("@loqui/shared").CalendarEvent;

let failures = 0;
function pass(msg: string): void {
  process.stdout.write(`  ok   ${msg}\n`);
}
function fail(msg: string): void {
  failures += 1;
  process.stdout.write(`  FAIL ${msg}\n`);
}
function assert(cond: boolean, msg: string): void {
  if (cond) pass(msg);
  else fail(msg);
}

/** A reversible fake safeStorage (prefix + reversed bytes) so we can prove the
 *  on-disk token blob is ciphertext and never the plaintext refresh token. */
const ENC_PREFIX = "enc:";
function makeFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) =>
      Buffer.from(ENC_PREFIX + [...plain].reverse().join(""), "utf8"),
    decryptString: (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (!s.startsWith(ENC_PREFIX)) throw new Error("bad ciphertext");
      return [...s.slice(ENC_PREFIX.length)].reverse().join("");
    },
    getSelectedStorageBackend: () => "keychain",
  };
}

/** A custom seed: a Meet event + a Zoom event later today, plus a SHARED invite
 *  (identical joinUrl) that both accounts will also report — to exercise dedup. */
function seedFor(now: number) {
  const SHARED_URL = "https://meet.google.com/shared-invite-xyz";
  return (account: string): CalendarEvent[] => {
    const mk = (offsetMin: number): { startsAt: string; endsAt: string } => ({
      startsAt: new Date(now + offsetMin * 60_000).toISOString(),
      endsAt: new Date(now + (offsetMin + 30) * 60_000).toISOString(),
    });
    return [
      calendarEventSchema.parse({
        id: `${account}-evt-1`,
        title: `Standup (${account})`,
        ...mk(120),
        platform: "google-meet",
        joinUrl: `https://meet.google.com/${account}-room`,
        attendees: [{ name: "Alex", email: "alex@example.com" }],
        source: account.includes("zoom") ? "zoom" : "google",
        calendarAccount: account,
      }),
      // The earliest event today — must sort FIRST.
      calendarEventSchema.parse({
        id: `${account}-evt-0`,
        title: `Earlybird (${account})`,
        ...mk(30),
        platform: "zoom",
        joinUrl: `https://zoom.us/j/${account}-1`,
        attendees: [],
        source: account.includes("zoom") ? "zoom" : "google",
        calendarAccount: account,
      }),
      // The SHARED invite both accounts report (same joinUrl) -> de-duped to one.
      calendarEventSchema.parse({
        id: `${account}-shared`,
        title: "Company all-hands",
        ...mk(240),
        platform: "google-meet",
        joinUrl: SHARED_URL,
        attendees: [{ name: "Everyone", email: null }],
        source: account.includes("zoom") ? "zoom" : "google",
        calendarAccount: account,
      }),
    ];
  };
}

async function main(): Promise<void> {
  process.stdout.write("loqui calendar Home/Today smoke test (FAKE provider, no network)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-calendar-smoke-"));
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.env.LOQUI_DATA_DIR = dataDir;

  const NOW = Date.parse("2026-06-24T08:00:00Z");
  const seed = seedFor(NOW);

  const tokenStore = new CalendarKeystore(makeFakeSafeStorage());
  const googleAccount = "me@gmail.com";
  const zoomAccount = "me@zoom.com";
  const service = createCalendarService({
    tokenStore,
    providers: {
      google: new FakeCalendarProvider({ source: "google", account: googleAccount, seed, now: () => NOW }),
      zoom: new FakeCalendarProvider({ source: "zoom", account: zoomAccount, seed, now: () => NOW }),
    },
    now: () => NOW,
    pollIntervalMs: 0, // no background polling in the smoke
  });

  const store = openStore();

  try {
    // Snapshot the data dir so we can prove ONLY calendar-tokens.json + the
    // index.db get written by connect (no calendar file leak, no transcript).
    const beforeFiles = new Set(readdirSync(dataDir));

    // --- 1. connect both accounts; tokens persist encrypted ---
    const g = await service.connect("google");
    const z = await service.connect("zoom");
    assert(g.connected && g.account === googleAccount, "connect(google) -> connected + account");
    assert(z.connected && z.account === zoomAccount, "connect(zoom) -> connected + account");

    const tokensFile = join(dataDir, "calendar-tokens.json");
    assert(existsSync(tokensFile), "calendar-tokens.json written on connect");
    const tokensRaw = readFileSync(tokensFile, "utf8");
    assert(
      !tokensRaw.includes("fake-refresh-google") && !tokensRaw.includes("fake-access-google"),
      "tokens stored encrypted (no plaintext refresh/access token on disk)",
    );
    const conns = await service.getConnections();
    assert(conns.length === 2, "getConnections lists both accounts");
    assert(
      JSON.stringify(conns).indexOf("fake-refresh") === -1,
      "getConnections never returns token material",
    );

    // --- 2. listToday: merged across accounts, soonest-first, platform + joinUrl ---
    const today = await service.listToday();
    const starts = today.map((e) => e.startsAt);
    assert(
      JSON.stringify([...starts].sort()) === JSON.stringify(starts),
      "listToday is sorted soonest-first",
    );
    assert(
      today.some((e) => e.source === "google") && today.some((e) => e.source === "zoom"),
      "listToday merges events from BOTH connected accounts",
    );
    const earliest = today[0];
    assert(
      !!earliest && earliest.title.startsWith("Earlybird"),
      "the earliest event sorts first",
    );
    assert(
      today.every((e) => typeof e.joinUrl === "string" && e.joinUrl.length > 0),
      "every today event carries a joinUrl",
    );
    assert(
      today.some((e) => e.platform === "google-meet") && today.some((e) => e.platform === "zoom"),
      "platforms (google-meet + zoom) preserved through normalization",
    );

    // --- 3. de-dup: the shared all-hands invite collapses to ONE event ---
    const allHands = today.filter((e) => e.title === "Company all-hands");
    assert(
      allHands.length === 1,
      "the SAME invite on two accounts is de-duplicated to one event",
    );

    // --- 4. "join & record": create a meeting from an event + link it ---
    const target = today.find((e) => e.title.startsWith("Standup"));
    assert(!!target, "found a today event to join & record");
    const joinEvent = target as CalendarEvent;
    // The renderer opens joinEvent.joinUrl (window.open / shell.openExternal);
    // here we only assert the URL is present, then start + link the meeting.
    assert(typeof joinEvent.joinUrl === "string", "join URL present for join & record");

    const meeting = store.createMeeting({
      title: joinEvent.title,
      platform: joinEvent.platform ?? undefined,
    });
    assert(meeting.status === "recording", "meeting created from the event (status recording)");
    assert(meeting.title === joinEvent.title, "meeting title pre-filled from the event");
    assert(meeting.platform === joinEvent.platform, "meeting platform pre-filled from the event");

    const linked = service.linkMeeting(joinEvent.id, meeting.id);
    assert(linked?.meetingId === meeting.id, "linkMeeting set CalendarEvent.meetingId");

    const todayAfter = await service.listToday();
    assert(
      todayAfter.find((e) => e.id === joinEvent.id)?.meetingId === meeting.id,
      "the linked meetingId is visible on the cached event",
    );

    // The linked meeting shows in the Library list.
    const listed = store.listMeetings();
    assert(
      listed.some((m) => m.id === meeting.id && m.title === joinEvent.title),
      "the linked meeting appears in listMeetings (the Library)",
    );
    assert(existsSync(meetingMetaPath(meeting.id)), "meeting meta.json exists on disk");

    // --- 5. READ-ONLY invariants ---
    // No calendar file beyond calendar-tokens.json (the only calendar artifact).
    const afterFiles = readdirSync(dataDir).filter((f) => !beforeFiles.has(f));
    const unexpectedCalendarFiles = afterFiles.filter(
      (f) => f.toLowerCase().includes("calendar") && f !== "calendar-tokens.json",
    );
    assert(
      unexpectedCalendarFiles.length === 0,
      `no calendar file written beyond calendar-tokens.json (saw: ${afterFiles.join(", ") || "none"})`,
    );

    // The calendar feature NEVER writes a transcript: the linked meeting has no
    // transcript.live.md (only the recording pipeline writes one — not touched).
    const transcriptPath = meetingLiveTranscriptPath(meeting.id);
    assert(
      !existsSync(transcriptPath),
      "calendar never wrote transcript.live.md for the linked meeting",
    );

    // A pre-existing transcript on an unrelated meeting stays byte-identical
    // across the whole calendar flow.
    const other = store.createMeeting({ title: "Pre-existing" });
    const otherTranscript = meetingLiveTranscriptPath(other.id);
    mkdirSync(dirname(otherTranscript), { recursive: true });
    const ORIGINAL = "[00:00:01] You said: untouched by calendar\n";
    writeFileSync(otherTranscript, ORIGINAL, "utf8");
    const before = readFileSync(otherTranscript);
    await service.refresh();
    service.linkMeeting(joinEvent.id, meeting.id);
    await service.listToday();
    const afterBytes = readFileSync(otherTranscript);
    assert(
      Buffer.compare(before, afterBytes) === 0,
      "an existing transcript.live.md is byte-identical after the calendar flow",
    );
  } catch (e) {
    fail(`unexpected error: ${(e as Error)?.stack ?? e}`);
  } finally {
    try {
      service.dispose();
    } catch {
      /* ignore */
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (failures > 0) {
    process.stdout.write(`\ncalendar smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\ncalendar smoke PASSED\n");
}

main().catch((err) => {
  process.stderr.write(`\ncalendar smoke ERROR: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});
