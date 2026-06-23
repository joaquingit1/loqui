#!/usr/bin/env tsx
/**
 * PRD-3 meeting end-to-end smoke body (run via scripts/smoke-meeting.mjs under
 * tsx). No model, no devices, no Electron, no microphone, no network.
 *
 * Wires the REAL main-process PRD-3 modules together and drives a full meeting:
 *
 *   spawn sidecar (LOQUI_FAKE_ASR=1, matching temp LOQUI_DATA_DIR)
 *     -> openStore()                       (real MeetingStore: meta.json + FTS)
 *     -> createTranscriptWriter()          (the ONE append-only transcript.live.md writer)
 *     -> consumeFinalTranscriptSegments()  (final-segment consumer: writer + FTS)
 *     -> createMeetingController()         (lifecycle: status/startedAt/endedAt)
 *
 * A fake supervisor stands in for SidecarSupervisor: it implements the two seams
 * the PRD-3 modules use — `onNotification` (fanned out from the live WS) and
 * `setActiveMeeting` — so the smoke exercises the actual consumer/writer/store
 * code rather than a reimplementation. The sidecar's FAKE ASR backend turns
 * synthetic marker PCM into real transcriptSegment WS notifications via the REAL
 * streaming pipeline (VAD -> ASR -> LocalAgreement-2).
 *
 * Asserts (exits non-zero on the first failure):
 *   1. controller.startMeeting() -> status "recording", startedAt set, active.
 *   2. transcript.live.md gets BOTH a "You said:" (mic) and a "They said:"
 *      (system) line within a timeout.
 *   3. meta.json exists on disk for the meeting.
 *   4. an FTS index row exists (a spoken keyword is searchable).
 *   5. controller.stopMeeting() -> status "done", endedAt set, active cleared.
 *   6. store.listMeetings() returns the meeting; searchMeetings finds a spoken
 *      keyword (hit carries the right meeting + a snippet).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DESKTOP = join(REPO_ROOT, "apps/desktop");
const SIDECAR_PROJECT = join(REPO_ROOT, "sidecar");

const require = createRequire(join(DESKTOP, "package.json"));
const { WebSocket } = require("ws") as typeof import("ws");

// @loqui/shared is not link-resolvable from repo-root scripts/, so import its
// built dist by absolute path (same pattern as the other smoke harnesses). The
// store/transcript modules below resolve their own @loqui/shared from within
// apps/desktop where it IS linked.
const { AUDIO_SAMPLE_RATE, TRANSCRIPT_SEGMENT_EVENT } = (await import(
  new URL(`file://${join(REPO_ROOT, "packages/shared/dist/index.js")}`).href
)) as typeof import("@loqui/shared");

// REAL main-process PRD-3 modules (TS source, run under tsx).
const { openStore, meetingMetaPath, meetingLiveTranscriptPath } = (await import(
  new URL(`file://${join(DESKTOP, "src/main/store/index.ts")}`).href
)) as typeof import("../apps/desktop/src/main/store/index.js");

const {
  createTranscriptWriter,
  consumeFinalTranscriptSegments,
  createMeetingController,
} = (await import(
  new URL(`file://${join(DESKTOP, "src/main/transcript/index.ts")}`).href
)) as typeof import("../apps/desktop/src/main/transcript/index.js");

// 20 ms frames @ 16 kHz mono = 320 samples/frame.
const { encodeFrame } = (await import(
  new URL(`file://${join(REPO_ROOT, "packages/audio/dist/frame-codec.js")}`).href
)) as {
  encodeFrame: (source: string, seq: number, tsMs: number, pcm: Int16Array) => Uint8Array;
};

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;
const TRANSCRIPT_TIMEOUT_MS = 15_000;

const FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * 20) / 1000; // 320
const SPEECH_FRAMES = 100; // ~2.0 s of "speech" per source
const SILENCE_FRAMES = 50; // ~1.0 s trailing silence -> VAD endpoint

// Source markers: the sidecar's fake_stream recovers a per-source phrase from
// the dominant sample value. MUST match loqui_sidecar fake_stream._MARKER_SAMPLE.
const MARKER_SAMPLE: Record<string, number> = { mic: 6000, system: 12000 };

// A keyword we expect to be searchable from the spoken (final) text. The fake
// backend's per-source phrases include these words (mirrors fake_stream).
const MIC_KEYWORD = "microphone";
const SYSTEM_KEYWORD = "remote";

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

/** One 20 ms frame: marker PCM (speech) or zeros (silence). */
function frameFor(source: string, frameIndex: number, silence: boolean): Uint8Array {
  const pcm = new Int16Array(FRAME_SAMPLES);
  if (!silence) pcm.fill(MARKER_SAMPLE[source]);
  const tsMs = ((frameIndex * FRAME_SAMPLES) / AUDIO_SAMPLE_RATE) * 1000;
  return encodeFrame(source, frameIndex, tsMs, pcm);
}

interface Handshake {
  port: number;
  token: string;
}

function startSidecar(
  dataDir: string,
): Promise<{ child: ChildProcess; handshake: Handshake }> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOQUI_DATA_DIR: dataDir, LOQUI_FAKE_ASR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `handshake not received within ${HANDSHAKE_TIMEOUT_MS}ms; stderr:\n${stderr}`,
        ),
      );
    }, HANDSHAKE_TIMEOUT_MS);

    function finish(err: Error | null, handshake?: Handshake): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      if (err) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve({ child, handshake: handshake as Handshake });
      }
    }

    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      const nl = stdout.indexOf("\n");
      if (nl === -1) return;
      const line = stdout.slice(0, nl);
      try {
        finish(null, JSON.parse(line) as Handshake);
      } catch {
        finish(new Error(`handshake line is not valid JSON: ${line}`));
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (e) => finish(new Error(`failed to spawn sidecar: ${e.message}`)));
    child.on("exit", (code) => {
      if (!settled)
        finish(
          new Error(`sidecar exited (code ${code}) before handshake; stderr:\n${stderr}`),
        );
    });
  });
}

function connectWs(port: number, token: string): Promise<InstanceType<typeof WebSocket>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error("WS connect timed out"));
    }, STEP_TIMEOUT_MS);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function audioControl(
  event: "audioStart" | "audioStop",
  meetingId: string,
  source: string,
): string {
  const data =
    event === "audioStart"
      ? {
          meetingId,
          source,
          sampleRate: AUDIO_SAMPLE_RATE,
          channels: 1,
          encoding: "pcm_s16le",
        }
      : { meetingId, source };
  return JSON.stringify({ type: "notification", event, data });
}

function sendBinary(
  ws: InstanceType<typeof WebSocket>,
  bytes: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(bytes, { binary: true }, (err) => (err ? reject(err) : resolve()));
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    child.once("exit", onExit);
  });
}

async function main(): Promise<void> {
  process.stdout.write("loqui meeting end-to-end smoke test (FAKE ASR)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-meeting-smoke-"));
  process.stdout.write(`  data root: ${dataDir}\n`);

  // The store + transcript modules resolve their data root from LOQUI_DATA_DIR
  // (same env the sidecar reads), so both processes agree on the meeting dir.
  process.env.LOQUI_DATA_DIR = dataDir;

  let child: ChildProcess | null = null;
  let ws: InstanceType<typeof WebSocket> | null = null;
  const store = openStore();

  // Fake supervisor: the two seams the PRD-3 main modules use. onNotification is
  // fed from the live WS; setActiveMeeting is recorded so we can assert routing.
  const notificationListeners = new Set<(event: string, data: unknown) => void>();
  let activeMeetingId: string | null = null;
  const supervisor = {
    onNotification(cb: (event: string, data: unknown) => void): () => void {
      notificationListeners.add(cb);
      return () => notificationListeners.delete(cb);
    },
    setActiveMeeting(id: string | null): void {
      activeMeetingId = id;
    },
  };
  function emitNotification(event: string, data: unknown): void {
    for (const cb of notificationListeners) {
      try {
        cb(event, data);
      } catch {
        /* ignore */
      }
    }
  }

  // Wire the REAL final-segment consumer: appends finals to transcript.live.md
  // (via the append-only writer) AND indexes them into FTS.
  const writer = createTranscriptWriter();
  const disposeConsumer = consumeFinalTranscriptSegments({ supervisor, writer, store });

  // The REAL lifecycle controller over the real store + fake supervisor.
  const controller = createMeetingController({ store, supervisor });

  try {
    ({ child } = await startSidecar(dataDir).then(async (r) => {
      const ws2 = await connectWs(r.handshake.port, r.handshake.token);
      ws = ws2;
      pass("sidecar spawned + WS connected with token");
      return r;
    }));

    // Fan EVERY inbound transcriptSegment WS notification into the consumer.
    ws!.on("message", (data: Buffer) => {
      let frame: { type?: string; event?: string; data?: unknown };
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (frame?.type === "notification" && frame.event === TRANSCRIPT_SEGMENT_EVENT) {
        emitNotification(TRANSCRIPT_SEGMENT_EVENT, frame.data);
      }
    });

    // --- 1. start the meeting via the REAL controller ---
    const started = await controller.startMeeting({
      title: "Smoke Meeting",
      platform: "other",
    });
    const meetingId = started.id;
    process.stdout.write(`  meeting:   ${meetingId}\n`);
    assert(started.status === "recording", "started meeting status === recording");
    assert(
      typeof started.startedAt === "string" && started.startedAt.length > 0,
      "startedAt set",
    );
    assert(
      activeMeetingId === meetingId,
      "supervisor active meeting routed to the new id",
    );
    assert(
      controller.getActiveMeeting()?.id === meetingId,
      "controller reports active meeting",
    );

    // --- 2/3/4. stream synthetic PCM for both sources; the sidecar emits real
    // finals; the consumer writes transcript.live.md + FTS ---
    ws!.send(audioControl("audioStart", meetingId, "system"));
    ws!.send(audioControl("audioStart", meetingId, "mic"));
    await delay(150);

    for (let i = 0; i < SPEECH_FRAMES; i++) {
      await sendBinary(ws!, frameFor("system", i, false));
      await sendBinary(ws!, frameFor("mic", i, false));
    }
    for (let i = SPEECH_FRAMES; i < SPEECH_FRAMES + SILENCE_FRAMES; i++) {
      await sendBinary(ws!, frameFor("system", i, true));
      await sendBinary(ws!, frameFor("mic", i, true));
    }
    pass(`streamed ${(SPEECH_FRAMES + SILENCE_FRAMES) * 2} binary frames (both sources)`);
    await delay(400);

    // audioStop -> flush any buffered hypothesis into a final.
    ws!.send(audioControl("audioStop", meetingId, "mic"));
    ws!.send(audioControl("audioStop", meetingId, "system"));

    // Wait for transcript.live.md to gain BOTH speaker lines (within ~1s of
    // each confirmation; we allow a generous timeout for the smoke).
    const transcriptPath = meetingLiveTranscriptPath(meetingId);
    const deadline = Date.now() + TRANSCRIPT_TIMEOUT_MS;
    let transcript = "";
    let haveYou = false;
    let haveThey = false;
    while (Date.now() < deadline) {
      transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "";
      haveYou = /^\[\d\d:\d\d:\d\d\] You said: .+/m.test(transcript);
      haveThey = /^\[\d\d:\d\d:\d\d\] They said: .+/m.test(transcript);
      if (haveYou && haveThey) break;
      await delay(150);
    }
    assert(haveYou, `transcript.live.md has a "You said:" (mic) line`);
    assert(haveThey, `transcript.live.md has a "They said:" (system) line`);
    if (!haveYou || !haveThey) {
      process.stdout.write(`  --- transcript.live.md ---\n${transcript}\n  ---\n`);
    }

    // meta.json exists on disk.
    assert(
      existsSync(meetingMetaPath(meetingId)),
      "meta.json exists on disk for the meeting",
    );

    // An FTS index row exists: a spoken keyword is searchable while recording.
    const liveHits = store.searchMeetings(MIC_KEYWORD);
    assert(
      liveHits.some((h) => h.meeting.id === meetingId),
      `FTS index row exists (search "${MIC_KEYWORD}" finds the meeting)`,
    );

    // --- 5. stop the meeting via the REAL controller ---
    const stopped = await controller.stopMeeting({ id: meetingId });
    assert(stopped.status === "done", "stopped meeting status === done");
    assert(
      typeof stopped.endedAt === "string" && stopped.endedAt.length > 0,
      "endedAt set",
    );
    assert(activeMeetingId === null, "supervisor active meeting cleared on stop");
    assert(
      controller.getActiveMeeting() === null,
      "controller reports no active meeting",
    );

    // --- 6. library list + search after stop ---
    const listed = store.listMeetings();
    assert(
      listed.some((m) => m.id === meetingId && m.status === "done"),
      "listMeetings returns the stopped meeting (status done)",
    );

    const micHit = store.searchMeetings(MIC_KEYWORD);
    assert(
      micHit.some((h) => h.meeting.id === meetingId),
      `searchMeetings finds a spoken mic keyword ("${MIC_KEYWORD}")`,
    );
    const sysHit = store.searchMeetings(SYSTEM_KEYWORD);
    assert(
      sysHit.some((h) => h.meeting.id === meetingId),
      `searchMeetings finds a spoken system keyword ("${SYSTEM_KEYWORD}")`,
    );
    const hit = micHit.find((h) => h.meeting.id === meetingId);
    assert(
      typeof hit?.snippet === "string" && hit.snippet.length > 0,
      "search hit carries a snippet",
    );
  } catch (e) {
    fail(`unexpected error: ${(e as Error)?.stack ?? e}`);
  } finally {
    try {
      disposeConsumer();
    } catch {
      /* ignore */
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await waitForExit(child, 2_000);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stdout.write(`\nmeeting smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nmeeting smoke PASSED\n");
}

main().catch(async (err) => {
  process.stderr.write(`\nmeeting smoke ERROR: ${(err as Error)?.stack ?? err}\n`);
  await delay(50);
  process.exit(1);
});
