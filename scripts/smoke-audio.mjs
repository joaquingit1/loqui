#!/usr/bin/env node
/**
 * PRD-1 audio-path smoke test (no audio devices, no Electron, no microphone).
 *
 * Spawns the REAL Python sidecar via `uv run` (reusing the PRD-0 spawn pattern:
 * stdin held open as the parent-liveness channel + token handshake on stdout),
 * points it at a TEMP data root via LOQUI_DATA_DIR, and drives the binary audio
 * ingest path end-to-end with SYNTHETIC PCM — proving the renderer→main→sidecar
 * wire format and the per-source WAV writer agree, and that the two streams stay
 * independent.
 *
 * Flow:
 *   1. spawn sidecar (LOQUI_DATA_DIR=<tmp>), parse handshake {port, token}.
 *   2. WS connect with the token.
 *   3. audioStart for source "system" AND source "mic" (control notifications).
 *   4. stream a few seconds of synthetic pcm_s16le frames per source — DISTINCT
 *      known signals (mic = a sine; system = a different-frequency sine) —
 *      encoded with the REAL @loqui/audio frame codec, sent as WS BINARY frames.
 *   5. audioStop for both sources.
 *   6. assert <tmp>/meetings/<id>/audio/mic.wav and system.wav:
 *        - exist,
 *        - are 16 kHz / mono / 16-bit pcm_s16le WAV,
 *        - have ~the expected duration (sample count we streamed),
 *        - are NOT byte-identical (streams stayed separate / unmixed).
 *
 * Exits non-zero on the first failure.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SIDECAR_PROJECT = join(REPO_ROOT, "sidecar");

// `ws` lives under @loqui/desktop (not hoisted to root); anchor resolution there
// so this runs on CI's Node 20 too (built-in WebSocket isn't stable until 22).
const require = createRequire(join(REPO_ROOT, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

// The frame codec is the single source of truth for the wire layout: import the
// BUILT @loqui/audio output and use its encodeFrame so the smoke exercises the
// exact bytes the renderer produces (header + pcm_s16le). Falls back nowhere —
// build it first: `corepack pnpm --filter @loqui/audio build`.
const AUDIO_DIST = join(REPO_ROOT, "packages/audio/dist/frame-codec.js");
const SHARED_DIST = join(REPO_ROOT, "packages/shared/dist/index.js");
let encodeFrame;
let AUDIO_SAMPLE_RATE;
try {
  ({ encodeFrame } = await import(new URL(`file://${AUDIO_DIST}`).href));
  ({ AUDIO_SAMPLE_RATE } = await import(new URL(`file://${SHARED_DIST}`).href));
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

// Synthetic-capture parameters. 20 ms frames @ 16 kHz mono = 320 samples/frame.
const FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * 20) / 1000; // 320
const FRAMES_PER_SOURCE = 100; // 100 * 20 ms = 2.0 s per source
const TOTAL_SAMPLES = FRAME_SAMPLES * FRAMES_PER_SOURCE; // 32000
const EXPECTED_SECONDS = TOTAL_SAMPLES / AUDIO_SAMPLE_RATE; // 2.0 s

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

/**
 * Build one frame of a distinct synthetic signal for a source. mic and system
 * use DIFFERENT tones so the resulting WAVs cannot be byte-identical unless the
 * sidecar mixed/cross-wired the streams (the exact regression we guard).
 */
function syntheticFrame(source, frameIndex) {
  // mic = 440 Hz at 0.6 amplitude; system = 880 Hz at 0.3 amplitude.
  const freq = source === "mic" ? 440 : 880;
  const amp = source === "mic" ? 0.6 : 0.3;
  const pcm = new Int16Array(FRAME_SAMPLES);
  const baseSample = frameIndex * FRAME_SAMPLES;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (baseSample + i) / AUDIO_SAMPLE_RATE;
    pcm[i] = Math.round(Math.sin(2 * Math.PI * freq * t) * amp * 32767);
  }
  const seq = frameIndex;
  const tsMs = (baseSample / AUDIO_SAMPLE_RATE) * 1000;
  return encodeFrame(source, seq, tsMs, pcm);
}

/** Spawn the sidecar with LOQUI_DATA_DIR set; resolve on the handshake line. */
function startSidecar(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"],
      {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        // Pin a temp data root AND force the hermetic FAKE ASR backend (PRD-2):
        // this audio-capture gate asserts the per-source WAV path, NOT real
        // transcription, so it must never load faster-whisper / fetch a model.
        env: { ...process.env, LOQUI_DATA_DIR: dataDir, LOQUI_FAKE_ASR: "1" },
      },
    );

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
        finish(
          new Error(`sidecar exited (code ${code}) before handshake; stderr:\n${stderr}`),
        );
    });
  });
}

/** Open a WS to the sidecar's /ws endpoint with the token. */
function connectWs(port, token) {
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

/** audioStart / audioStop control notification, exactly as the client sends it. */
function audioControl(event, meetingId, source) {
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
  return { type: "notification", event, data };
}

/** Send a JSON frame and resolve after a short quiet window (notifications are
 *  one-way; a reply only arrives on a validation error, which we surface). */
function sendNotification(ws, frame, quietMs = 300) {
  return new Promise((resolve) => {
    let errReply = null;
    const onMessage = (data) => {
      try {
        errReply = JSON.parse(data.toString("utf8"));
      } catch {
        /* ignore */
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify(frame));
    setTimeout(() => {
      ws.off("message", onMessage);
      resolve(errReply);
    }, quietMs);
  });
}

/** Send one binary frame; resolve once the socket has flushed it to the OS. */
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

/**
 * Minimal WAV (RIFF) reader: parse the fmt + data chunks and return
 * {channels, sampleRate, bitsPerSample, dataBytes, data}. Throws on a
 * non-canonical/short file so a malformed WAV fails the smoke loudly.
 */
function readWav(path) {
  const buf = readFileSync(path);
  if (buf.length < 44) throw new Error(`WAV too short: ${buf.length} bytes`);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("missing RIFF tag");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("missing WAVE tag");

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
    }
    // Chunks are word-aligned (pad byte for odd sizes).
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error("no fmt chunk");
  if (!data) throw new Error("no data chunk");
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
    dataBytes: data.length,
    data,
  };
}

async function main() {
  process.stdout.write("loqui audio-path smoke test\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-audio-smoke-"));
  const meetingId = randomUUID();
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.stdout.write(`  meeting:   ${meetingId}\n`);
  process.stdout.write(
    `  streaming ${FRAMES_PER_SOURCE} frames/source (${EXPECTED_SECONDS.toFixed(2)} s @ ${AUDIO_SAMPLE_RATE} Hz)\n`,
  );

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

  try {
    const { port, token } = handshake;
    assert(Number.isInteger(port) && port > 0, `handshake.port (${port})`);
    assert(typeof token === "string" && token.length > 0, "handshake.token present");

    ws = await connectWs(port, token);
    pass("WS connected with token");

    // 3. audioStart for BOTH sources (system first, then mic — interleave order
    //    must not matter; each source has its own writer).
    const startSys = await sendNotification(ws, audioControl("audioStart", meetingId, "system"));
    assert(startSys === null, "audioStart(system) accepted (no validation error)");
    const startMic = await sendNotification(ws, audioControl("audioStart", meetingId, "mic"));
    assert(startMic === null, "audioStart(mic) accepted (no validation error)");

    // 4. Stream synthetic frames, INTERLEAVED per frame index so a cross-wiring
    //    bug (writing both sources to one file) would show up.
    for (let i = 0; i < FRAMES_PER_SOURCE; i++) {
      await sendBinary(ws, syntheticFrame("system", i));
      await sendBinary(ws, syntheticFrame("mic", i));
    }
    pass(`streamed ${FRAMES_PER_SOURCE * 2} binary frames (both sources)`);

    // 5. audioStop for both sources -> sidecar finalizes (back-patches) the WAVs.
    await sendNotification(ws, audioControl("audioStop", meetingId, "mic"));
    await sendNotification(ws, audioControl("audioStop", meetingId, "system"));
    pass("audioStop(mic) + audioStop(system) sent");

    // Give the ingest a moment to flush + close the files on its event loop.
    await delay(400);

    // 6. Assert the two WAVs.
    const audioDir = join(dataDir, "meetings", meetingId, "audio");
    const micPath = join(audioDir, "mic.wav");
    const systemPath = join(audioDir, "system.wav");

    assert(existsSync(micPath), `mic.wav exists (${micPath})`);
    assert(existsSync(systemPath), `system.wav exists (${systemPath})`);

    if (existsSync(micPath) && existsSync(systemPath)) {
      const mic = readWav(micPath);
      const sys = readWav(systemPath);

      for (const [name, wav] of [
        ["mic", mic],
        ["system", sys],
      ]) {
        assert(wav.channels === 1, `${name}.wav is mono (channels=${wav.channels})`);
        assert(
          wav.sampleRate === AUDIO_SAMPLE_RATE,
          `${name}.wav is ${AUDIO_SAMPLE_RATE} Hz (got ${wav.sampleRate})`,
        );
        assert(
          wav.bitsPerSample === 16,
          `${name}.wav is 16-bit (got ${wav.bitsPerSample})`,
        );
        // Expected payload = TOTAL_SAMPLES * 2 bytes/sample (mono pcm_s16le).
        const expectedBytes = TOTAL_SAMPLES * 2;
        assert(
          wav.dataBytes === expectedBytes,
          `${name}.wav has expected duration: ${wav.dataBytes} data bytes ` +
            `(~${(wav.dataBytes / 2 / AUDIO_SAMPLE_RATE).toFixed(2)} s; expected ${expectedBytes})`,
        );
      }

      // Independence: the two streams carried DIFFERENT signals, so their PCM
      // payloads must NOT be byte-identical. Identical payloads would mean the
      // sidecar mixed or cross-wired the sources.
      const sameLength = mic.dataBytes === sys.dataBytes;
      const identical = sameLength && mic.data.equals(sys.data);
      assert(!identical, "mic.wav and system.wav PCM are NOT identical (streams stayed separate)");

      // Sanity: each file is non-empty (the writer actually got frames).
      assert(mic.dataBytes > 0 && sys.dataBytes > 0, "both WAVs contain PCM data");
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
    process.stdout.write(`\naudio smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\naudio smoke PASSED\n");
}

main().catch(async (err) => {
  process.stderr.write(`\naudio smoke ERROR: ${err?.stack ?? err}\n`);
  await delay(50);
  process.exit(1);
});
