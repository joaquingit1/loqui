#!/usr/bin/env tsx
/**
 * PRD-6 Google-Meet speaker-name attribution smoke body (run via
 * scripts/smoke-speakernames.mjs under tsx). NO Electron, NO live Meet, no model,
 * NO network beyond a 127.0.0.1 listener this smoke asserts is loopback-only.
 *
 * Wires the REAL main-process PRD-6 leaf modules together and drives the full
 * cross-process seam — exactly the integration the unit suites cannot cover
 * because they each use fakes:
 *
 *   createExtensionWsServer({ activeMeeting })   (the REAL loopback WS server)
 *     -> a REAL `ws` client connects over 127.0.0.1 (asserted loopback)
 *     -> hello + activity frames pushed WHILE a meeting is "active"
 *     -> drainActivity(meetingId)
 *     -> correlateSpeakerNames(diarized, events, { meetingStartEpochMs })  (PURE)
 *     -> applySpeakerNames(store, result)         (REUSES the PRD-5 rewrite path)
 *
 * Asserts (exits non-zero on the first failure):
 *   1. the WS server binds 127.0.0.1 ONLY (never 0.0.0.0) — a LAN host can't reach it.
 *   2. the loopback channel IGNORES activity when no meeting is recording, and
 *      buffers it once one starts (the no-active-meeting invariant).
 *   3. an arbitrary website Origin is REFUSED on the upgrade (local-injection guard);
 *      a Meet-origin connection is accepted.
 *   4. after diarization, correlate+apply maps `Speaker N` -> the real names and
 *      they land in transcript.diarized.{json,md} + meta.participants.
 *   5. THE CROSS-CUTTING INVARIANT: transcript.live.md AND transcript.jsonl stay
 *      BYTE-IDENTICAL across the whole pass (names touch ONLY the derived files).
 *   6. GRACEFUL DEGRADATION: with NO extension ever connected (no events), the
 *      meeting completes with its generic `Speaker N` labels and NO error — the
 *      diarized files are byte-identical to the pre-correlation state.
 *   7. a low-confidence / ambiguous turn STAYS `Speaker N` (a wrong name is worse
 *      than a generic one).
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DESKTOP = join(REPO_ROOT, "apps/desktop");

// `ws` is the real client the extension would be; resolve it from apps/desktop
// where it's linked (same pattern as the other smoke harnesses).
const require = createRequire(join(DESKTOP, "package.json"));
const { WebSocket } = require("ws") as typeof import("ws");

// @loqui/shared isn't link-resolvable from repo-root scripts/, so import its
// built dist by absolute path. The desktop main modules below resolve their own
// @loqui/shared from within apps/desktop where it IS linked.
const shared = (await import(
  new URL(`file://${join(REPO_ROOT, "packages/shared/dist/index.js")}`).href
)) as typeof import("@loqui/shared");
const { SPEAKERNAMES_WS_HOST, SPEAKERNAMES_WS_PATH, MEET_ORIGIN } = shared;

// REAL main-process PRD-6 leaf modules (TS source, run under tsx). Import the
// leaves directly (NOT the speakernames barrel) so we never pull in register.ts,
// which imports electron's ipcMain (unavailable outside Electron).
const { createExtensionWsServer } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/speakernames/ws-server.ts")}`).href
)) as typeof import("../apps/desktop/src/main/speakernames/ws-server.js");
const { correlateSpeakerNames } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/speakernames/correlate.ts")}`).href
)) as typeof import("../apps/desktop/src/main/speakernames/correlate.js");
const { applySpeakerNames } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/speakernames/apply.ts")}`).href
)) as typeof import("../apps/desktop/src/main/speakernames/apply.js");
const { writeDiarizedTranscript } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/postprocess/writers.ts")}`).href
)) as typeof import("../apps/desktop/src/main/postprocess/writers.js");

const {
  openStore,
  meetingLiveTranscriptPath,
  meetingTranscriptPath,
  meetingDiarizedTranscriptJsonPath,
  meetingDiarizedTranscriptMdPath,
} = (await import(
  new URL(`file://${join(DESKTOP, "src/main/store/index.ts")}`).href
)) as typeof import("../apps/desktop/src/main/store/index.js");

type Meeting = import("@loqui/shared").Meeting;
type ActiveMeetingSource =
  import("../apps/desktop/src/main/speakernames/types.js").ActiveMeetingSource;

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

/** A controllable active-meeting source (the slice the WS server needs). */
function fakeActiveMeeting(): ActiveMeetingSource & { set(m: Meeting | null): void } {
  let active: Meeting | null = null;
  const cbs = new Set<(m: Meeting | null) => void>();
  return {
    set(m) {
      active = m;
      for (const cb of cbs) cb(m);
    },
    getActiveMeeting: () => active,
    onActiveMeetingChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}

function connect(port: number, origin?: string): Promise<InstanceType<typeof WebSocket>> {
  const url = `ws://${SPEAKERNAMES_WS_HOST}:${port}${SPEAKERNAMES_WS_PATH}`;
  return new Promise((resolve, reject) => {
    const ws = origin ? new WebSocket(url, { origin }) : new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function sendJson(ws: InstanceType<typeof WebSocket>, obj: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(obj), (err?: Error) => (err ? reject(err) : resolve()));
  });
}

async function until(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

async function main(): Promise<void> {
  process.stdout.write("loqui speaker-names smoke test (REAL WS server, PURE engine, no Meet)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-speakernames-smoke-"));
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.env.LOQUI_DATA_DIR = dataDir;

  const store = openStore();
  const source = fakeActiveMeeting();
  const server = createExtensionWsServer({ activeMeeting: source, port: 0 });

  // The meeting start anchor (epoch ms). Diarized turns are seconds-from-start;
  // the activity events carry epoch-ms ts relative to this origin.
  const START = Date.parse("2026-06-24T10:00:00.000Z");
  const tAt = (sec: number): number => START + sec * 1000;

  try {
    // ---- 1) bind the loopback listener; assert it is 127.0.0.1 only ----
    const addr = await server.start();
    assert(addr.host === "127.0.0.1", `WS server bound loopback 127.0.0.1 (${addr.host})`);
    assert(addr.host !== "0.0.0.0", "WS server NOT bound 0.0.0.0 (a LAN host cannot reach it)");
    assert(addr.port > 0, `WS server bound an OS-assigned port (${addr.port})`);
    const port = addr.port;

    // ---- 3) Origin gate: refuse arbitrary site, accept Meet origin ----
    let refused = false;
    try {
      const evil = await connect(port, "https://evil.example.com");
      evil.close();
    } catch {
      refused = true;
    }
    assert(refused, "arbitrary website Origin is REFUSED on the WS upgrade (injection guard)");
    const meetWs = await connect(port, MEET_ORIGIN);
    assert(meetWs.readyState === WebSocket.OPEN, "a Meet-origin connection is accepted");

    // The REAL meeting: a Google-Meet meeting recording, with two system speakers.
    const created = store.createMeeting({ title: "Smoke standup", platform: "google-meet" });
    const meetingId = created.id;

    // hello first, then activity. With NO meeting active yet, activity is IGNORED.
    await sendJson(meetWs, {
      type: "hello",
      extensionVersion: "0.0.0-smoke",
      selectorVersion: "meet-2026.06",
      meetingCode: "abc-defg-hij",
      origin: MEET_ORIGIN,
    });
    await sendJson(meetWs, { type: "activity", event: { ts: tAt(1), name: "Ghost", speaking: true } });
    // Let the (to-be-dropped) frame fully traverse the socket + handler before we
    // assert it left no trace. A dropped frame leaves no observable signal, so we
    // settle on a short delay rather than a predicate, THEN activate the meeting.
    await new Promise((r) => setTimeout(r, 150));
    const idle = server.drainActivity(meetingId);
    assert(idle.events.length === 0, "loopback channel IGNORES activity when no meeting is recording");

    // ---- 2) now mark the meeting active; subsequent activity is BUFFERED ----
    source.set(created);
    // Alice speaks 0..8 (Speaker 1's turn), Bob speaks 10..18 (Speaker 2's turn).
    const events = [
      { ts: tAt(0), name: "Alice", speaking: true },
      { ts: tAt(8), name: "Alice", speaking: false },
      { ts: tAt(10), name: "Bob", speaking: true },
      { ts: tAt(18), name: "Bob", speaking: false },
    ];
    for (const e of events) await sendJson(meetWs, { type: "activity", event: e });
    const buffered = await until(() => {
      const s = server.getStatus();
      return s.meetingActive && s.bufferedEvents >= events.length;
    }, 2000);
    assert(buffered, `activity buffered once a meeting is recording (${server.getStatus().bufferedEvents})`);
    assert(
      server.getStatus().state === "capturing",
      `status is "capturing" while connected + buffering (${server.getStatus().state})`,
    );

    // ---- seed the diarized transcript (what PRD-5 writes) + the READ-ONLY live
    // transcript files the names must NEVER touch ----
    const meetingDir = join(dataDir, "meetings", meetingId);
    mkdirSync(meetingDir, { recursive: true });
    const livePath = meetingLiveTranscriptPath(meetingId);
    const structuredPath = meetingTranscriptPath(meetingId, "structured");
    const LIVE = "# Meeting transcript\n\nYou: hello\nThey: hi there\n";
    const STRUCTURED =
      [
        { segId: "s-mic-1", source: "mic", tStart: 0, tEnd: 2, text: "You: hello" },
        { segId: "s-sys-1", source: "system", tStart: 0, tEnd: 8, text: "They: hi there" },
        { segId: "s-sys-2", source: "system", tStart: 10, tEnd: 18, text: "They: sounds good" },
      ]
        .map((s) => JSON.stringify(s))
        .join("\n") + "\n";
    writeFileSync(livePath, LIVE, "utf8");
    writeFileSync(structuredPath, STRUCTURED, "utf8");
    const liveBefore = readFileSync(livePath);
    const structuredBefore = readFileSync(structuredPath);

    // The diarized transcript: "You" (mic) + two system clusters Speaker 1 / Speaker 2.
    writeDiarizedTranscript({
      meetingId,
      version: 1,
      diarized: true,
      backend: "fake",
      speakers: ["Speaker 1", "Speaker 2"],
      segments: [
        { segId: "s-mic-1", source: "mic", text: "You: hello", tStart: 0, tEnd: 2, speaker: "You", displayName: null },
        { segId: "s-sys-1", source: "system", text: "They: hi there", tStart: 0, tEnd: 8, speaker: "Speaker 1", displayName: null },
        { segId: "s-sys-2", source: "system", text: "They: sounds good", tStart: 10, tEnd: 18, speaker: "Speaker 2", displayName: null },
      ],
    });
    // Seed participants so the merge has rows to update (un-renamed: name===label).
    store.updateMeeting(meetingId, {
      participants: [
        { id: "Speaker 1", name: "Speaker 1", speakerLabel: "Speaker 1" },
        { id: "Speaker 2", name: "Speaker 2", speakerLabel: "Speaker 2" },
      ],
    });

    // ---- 4) drain + correlate + apply ----
    const drained = server.drainActivity(meetingId);
    assert(drained.events.length === events.length, `drainActivity returns the buffered events (${drained.events.length})`);
    assert(
      drained.participants.includes("Alice") && drained.participants.includes("Bob"),
      "drained participants include both captured names",
    );
    const result = correlateSpeakerNames(
      store.getDiarizedTranscript(meetingId)!,
      drained.events,
      { meetingStartEpochMs: START },
    );
    applySpeakerNames(store, result);

    const after = store.getDiarizedTranscript(meetingId)!;
    const s1 = after.segments.find((s) => s.segId === "s-sys-1");
    const s2 = after.segments.find((s) => s.segId === "s-sys-2");
    const mic = after.segments.find((s) => s.segId === "s-mic-1");
    assert(s1?.displayName === "Alice", `Speaker 1 resolved to "Alice" (${s1?.displayName})`);
    assert(s2?.displayName === "Bob", `Speaker 2 resolved to "Bob" (${s2?.displayName})`);
    assert(mic?.displayName == null, "the mic ('You') segment is never auto-resolved");

    // names landed in the rendered .md + meta.participants too.
    const md = readFileSync(meetingDiarizedTranscriptMdPath(meetingId), "utf8");
    assert(md.includes("Alice") && md.includes("Bob"), "diarized .md re-renders the resolved names");
    const parts = store.getMeeting(meetingId)?.participants ?? [];
    assert(
      parts.find((p) => p.speakerLabel === "Speaker 1")?.name === "Alice" &&
        parts.find((p) => p.speakerLabel === "Speaker 2")?.name === "Bob",
      "meta.participants carry the resolved names",
    );

    // ---- 5) THE INVARIANT: live + structured transcript byte-identical ----
    assert(
      Buffer.compare(liveBefore, readFileSync(livePath)) === 0,
      "transcript.live.md is BYTE-IDENTICAL after the name merge (never edited)",
    );
    assert(
      Buffer.compare(structuredBefore, readFileSync(structuredPath)) === 0,
      "transcript.jsonl is BYTE-IDENTICAL after the name merge (never edited)",
    );

    // ---- 6) GRACEFUL DEGRADATION: a fresh meeting with NO extension events ----
    const m2 = store.createMeeting({ title: "No extension", platform: "google-meet" });
    writeDiarizedTranscript({
      meetingId: m2.id,
      version: 1,
      diarized: true,
      backend: "fake",
      speakers: ["Speaker 1"],
      segments: [
        { segId: "g-sys-1", source: "system", text: "They: solo", tStart: 0, tEnd: 5, speaker: "Speaker 1", displayName: null },
      ],
    });
    const diarizedBefore2 = readFileSync(meetingDiarizedTranscriptJsonPath(m2.id));
    const empty = server.drainActivity(m2.id); // nobody ever connected for this id.
    const result2 = correlateSpeakerNames(store.getDiarizedTranscript(m2.id)!, empty.events, {
      meetingStartEpochMs: Date.now(),
    });
    const applied2 = applySpeakerNames(store, result2);
    const stillGeneric = store
      .getDiarizedTranscript(m2.id)!
      .segments.every((s) => s.displayName == null && s.speaker.startsWith("Speaker"));
    assert(empty.events.length === 0, "absent extension => no buffered activity (graceful)");
    assert(stillGeneric, "absent extension => meeting keeps generic `Speaker N` labels, no crash");
    assert(applied2 !== null, "the applier no-ops cleanly (returns the unchanged diarized)");
    assert(
      Buffer.compare(diarizedBefore2, readFileSync(meetingDiarizedTranscriptJsonPath(m2.id))) === 0,
      "no-op merge leaves the diarized .json byte-identical (nothing rewritten)",
    );

    // ---- 7) ambiguity stays `Speaker N`: two participants over one turn ----
    const m3 = store.createMeeting({ title: "Ambiguous", platform: "google-meet" });
    writeDiarizedTranscript({
      meetingId: m3.id,
      version: 1,
      diarized: true,
      backend: "fake",
      speakers: ["Speaker 1"],
      segments: [
        { segId: "a-sys-1", source: "system", text: "They: overlap", tStart: 0, tEnd: 10, speaker: "Speaker 1", displayName: null },
      ],
    });
    const ambiguous = [
      { ts: tAt(0), name: "Carol", speaking: true },
      { ts: tAt(10), name: "Carol", speaking: false },
      { ts: tAt(0), name: "Dave", speaking: true },
      { ts: tAt(10), name: "Dave", speaking: false },
    ];
    const result3 = correlateSpeakerNames(store.getDiarizedTranscript(m3.id)!, ambiguous, {
      meetingStartEpochMs: START,
    });
    applySpeakerNames(store, result3);
    const ambSeg = store.getDiarizedTranscript(m3.id)!.segments[0];
    assert(ambSeg?.displayName == null, "an ambiguous (near-tie) turn STAYS `Speaker N` (no wrong name)");

    meetWs.close();
  } catch (e) {
    fail(`unexpected error: ${(e as Error)?.stack ?? e}`);
  } finally {
    try {
      await server.stop();
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
    process.stdout.write(`\nspeakernames smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nspeakernames smoke PASSED\n");
}

main().catch((err) => {
  process.stderr.write(`\nspeakernames smoke ERROR: ${(err as Error)?.stack ?? err}\n`);
  process.exit(1);
});
