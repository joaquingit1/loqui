#!/usr/bin/env node
/**
 * PRD-2 transcription-path smoke test (no model, no devices, no Electron, no
 * microphone, no network).
 *
 * Spawns the REAL Python sidecar via `uv run` with LOQUI_FAKE_ASR=1 (the sidecar
 * honors this by wiring the deterministic, source-aware streaming FAKE ASR
 * backend — see loqui_sidecar/transcription/fake_stream.py — into the REAL
 * streaming pipeline: VAD endpointing -> AsrBackend -> LocalAgreement-2 ->
 * transcriptSegment notifications). Points it at a TEMP LOQUI_DATA_DIR so it
 * never touches ~/Loqui.
 *
 * It drives the full live path end-to-end with SYNTHETIC marker PCM and asserts
 * that transcriptSegment WS notifications arrive with:
 *   - both a `partial` and a `final` per source, partials preceding the final;
 *   - the correct per-source text (mic = "You" phrase, system = "They" phrase),
 *     with NO cross-wiring (mic words never appear on system and vice-versa);
 *   - a single `final` segId per utterance (no duplicate/overlapping finals);
 *   - the segment flushed on audioStop.
 *
 * Flow:
 *   1. spawn sidecar (LOQUI_FAKE_ASR=1, LOQUI_DATA_DIR=<tmp>), parse handshake.
 *   2. WS connect with the token; collect every inbound transcriptSegment.
 *   3. audioStart(system) + audioStart(mic).
 *   4. stream ~2 s of per-source MARKER pcm_s16le (mic -> sample 6000,
 *      system -> sample 12000) so the fake backend recovers the source phrase
 *      from content; then trailing silence so the VAD endpoints each utterance.
 *   5. audioStop both -> flush.
 *   6. assert the collected segments.
 *
 * Exits non-zero on the first failure.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SIDECAR_PROJECT = join(REPO_ROOT, "sidecar");

const require = createRequire(join(REPO_ROOT, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

const AUDIO_DIST = join(REPO_ROOT, "packages/audio/dist/frame-codec.js");
const SHARED_DIST = join(REPO_ROOT, "packages/shared/dist/index.js");
let encodeFrame;
let AUDIO_SAMPLE_RATE;
let TRANSCRIPT_SEGMENT_EVENT;
try {
  ({ encodeFrame } = await import(new URL(`file://${AUDIO_DIST}`).href));
  ({ AUDIO_SAMPLE_RATE, TRANSCRIPT_SEGMENT_EVENT } = await import(
    new URL(`file://${SHARED_DIST}`).href
  ));
} catch (e) {
  process.stderr.write(
    `\ncould not import @loqui/audio + @loqui/shared dist:\n${e?.message ?? e}\n` +
      "build them first:\n" +
      "  corepack pnpm --filter @loqui/shared build\n" +
      "  corepack pnpm --filter @loqui/audio build\n",
  );
  process.exit(1);
}

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;

// 20 ms frames @ 16 kHz mono = 320 samples/frame.
const FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * 20) / 1000; // 320
const SPEECH_FRAMES = 100; // 2.0 s of "speech" per source
const SILENCE_FRAMES = 50; // ~1.0 s trailing silence -> VAD endpoint

// Source markers: the sidecar's fake_stream recovers the phrase from the
// dominant sample value (mic -> 6000, system -> 12000). MUST match
// loqui_sidecar/transcription/fake_stream._MARKER_SAMPLE.
const MARKER_SAMPLE = { mic: 6000, system: 12000 };

// The expected per-source phrase words (mirror fake_stream.PHRASE_BY_MARKER).
const PHRASE = {
  mic: ["hello", "there", "this", "is", "the", "microphone", "speaking", "now"],
  system: ["the", "remote", "meeting", "audio", "is", "playing", "back", "clearly"],
};

let failures = 0;
function pass(msg) {
  process.stdout.write(`  ok   ${msg}\n`);
}
function fail(msg) {
  failures += 1;
  process.stdout.write(`  FAIL ${msg}\n`);
}
function assert(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

/** One 20 ms frame: marker PCM (speech) or zeros (silence). */
function frameFor(source, frameIndex, { silence }) {
  const pcm = new Int16Array(FRAME_SAMPLES);
  if (!silence) pcm.fill(MARKER_SAMPLE[source]);
  const seq = frameIndex;
  const tsMs = ((frameIndex * FRAME_SAMPLES) / AUDIO_SAMPLE_RATE) * 1000;
  return encodeFrame(source, seq, tsMs, pcm);
}

function startSidecar(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      // LOQUI_FAKE_ASR=1 is the contract the sidecar honors to stay hermetic
      // (no model, no network) while exercising the REAL streaming pipeline.
      env: { ...process.env, LOQUI_DATA_DIR: dataDir, LOQUI_FAKE_ASR: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`handshake not received within ${HANDSHAKE_TIMEOUT_MS}ms; stderr:\n${stderr}`));
    }, HANDSHAKE_TIMEOUT_MS);

    function finish(err, handshake) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      if (err) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve({ child, handshake });
      }
    }

    const onData = (chunk) => {
      stdout += chunk.toString("utf8");
      const nl = stdout.indexOf("\n");
      if (nl === -1) return;
      const line = stdout.slice(0, nl);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(new Error(`handshake line is not valid JSON: ${line}`));
        return;
      }
      finish(null, parsed);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (e) => finish(new Error(`failed to spawn sidecar: ${e.message}`)));
    child.on("exit", (code) => {
      if (!settled)
        finish(new Error(`sidecar exited (code ${code}) before handshake; stderr:\n${stderr}`));
    });
  });
}

function connectWs(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
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

function audioControl(event, meetingId, source) {
  const data =
    event === "audioStart"
      ? { meetingId, source, sampleRate: AUDIO_SAMPLE_RATE, channels: 1, encoding: "pcm_s16le" }
      : { meetingId, source };
  return { type: "notification", event, data };
}

function sendBinary(ws, bytes) {
  return new Promise((resolve, reject) => {
    ws.send(bytes, { binary: true }, (err) => (err ? reject(err) : resolve()));
  });
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function main() {
  process.stdout.write("loqui transcription-path smoke test (FAKE ASR)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-transcription-smoke-"));
  const meetingId = randomUUID();
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.stdout.write(`  meeting:   ${meetingId}\n`);

  let child = null;
  let ws = null;
  let handshake;
  try {
    ({ child, handshake } = await startSidecar(dataDir));
  } catch (e) {
    fail(`sidecar failed to start: ${e?.message ?? e}`);
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  }

  // Collect every transcriptSegment notification the sidecar pushes.
  const segments = [];

  try {
    const { port, token } = handshake;
    assert(Number.isInteger(port) && port > 0, `handshake.port (${port})`);
    assert(typeof token === "string" && token.length > 0, "handshake.token present");

    ws = await connectWs(port, token);
    pass("WS connected with token");

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (frame?.type === "notification" && frame.event === TRANSCRIPT_SEGMENT_EVENT) {
        segments.push(frame.data);
      }
    });

    // audioStart for BOTH sources (system first to prove order independence).
    ws.send(JSON.stringify(audioControl("audioStart", meetingId, "system")));
    ws.send(JSON.stringify(audioControl("audioStart", meetingId, "mic")));
    await delay(150);
    pass("audioStart(system) + audioStart(mic) sent");

    // Stream speech frames INTERLEAVED per index (a cross-wiring bug through the
    // shared backend would surface as mixed text).
    for (let i = 0; i < SPEECH_FRAMES; i++) {
      await sendBinary(ws, frameFor("system", i, { silence: false }));
      await sendBinary(ws, frameFor("mic", i, { silence: false }));
    }
    // Trailing silence -> the VAD endpoints each utterance into a final.
    for (let i = SPEECH_FRAMES; i < SPEECH_FRAMES + SILENCE_FRAMES; i++) {
      await sendBinary(ws, frameFor("system", i, { silence: true }));
      await sendBinary(ws, frameFor("mic", i, { silence: true }));
    }
    pass(`streamed ${(SPEECH_FRAMES + SILENCE_FRAMES) * 2} binary frames (both sources)`);

    // Let the sidecar's event loop drain queued segment sends.
    await delay(400);

    // audioStop -> flush any buffered hypothesis to a final.
    ws.send(JSON.stringify(audioControl("audioStop", meetingId, "mic")));
    ws.send(JSON.stringify(audioControl("audioStop", meetingId, "system")));
    await delay(500);
    pass("audioStop(mic) + audioStop(system) sent (flush)");

    // ---- assertions ----
    assert(segments.length > 0, `received transcriptSegment notifications (${segments.length})`);

    const bySource = { mic: [], system: [] };
    for (const s of segments) {
      if (s && (s.source === "mic" || s.source === "system")) bySource[s.source].push(s);
    }

    for (const source of ["mic", "system"]) {
      const segs = bySource[source];
      assert(segs.length > 0, `${source}: got segments (${segs.length})`);

      // Shape: matches the TranscriptSegment contract.
      const shapeOk = segs.every(
        (s) =>
          s.meetingId === meetingId &&
          s.source === source &&
          typeof s.text === "string" &&
          typeof s.tStart === "number" &&
          typeof s.tEnd === "number" &&
          (s.status === "partial" || s.status === "final") &&
          typeof s.segId === "string" &&
          s.segId.length > 0,
      );
      assert(shapeOk, `${source}: every segment matches the TranscriptSegment contract`);

      const statuses = segs.map((s) => s.status);
      assert(statuses.includes("partial"), `${source}: emitted a partial`);
      assert(statuses.includes("final"), `${source}: emitted a final`);
      assert(
        statuses.indexOf("partial") < statuses.indexOf("final"),
        `${source}: partial precedes final`,
      );

      // No duplicate final segIds.
      const finals = segs.filter((s) => s.status === "final");
      const finalIds = finals.map((s) => s.segId);
      assert(
        finalIds.length === new Set(finalIds).size,
        `${source}: no duplicate final segIds`,
      );

      // Correct per-source text + NO cross-wiring.
      const finalText = finals.map((s) => s.text).join(" ");
      const own = PHRASE[source];
      const other = source === "mic" ? "system" : "mic";
      const otherOnly = PHRASE[other].filter((w) => !own.includes(w));
      assert(
        own.some((w) => finalText.split(/\s+/).includes(w)),
        `${source}: final text contains this source's words ("${finalText}")`,
      );
      const tokens = new Set(finalText.split(/\s+/));
      const leaked = otherOnly.filter((w) => tokens.has(w));
      assert(leaked.length === 0, `${source}: no cross-wired words (leaked: ${leaked.join(",")})`);
    }
  } catch (e) {
    fail(`unexpected error: ${e?.stack ?? e}`);
  } finally {
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
    process.stdout.write(`\ntranscription smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\ntranscription smoke PASSED\n");
}

main().catch(async (err) => {
  process.stderr.write(`\ntranscription smoke ERROR: ${err?.stack ?? err}\n`);
  await delay(50);
  process.exit(1);
});
