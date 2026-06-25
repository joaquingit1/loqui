/**
 * smoke:import — PRD-12 file-import path, end-to-end over the REAL sidecar.
 *
 * Drives a SYNTHETIC WAV file through the actual sidecar `importFile` dispatch
 * (decode -> the EXISTING transcription engine -> the EXISTING diarization +
 * summary), proving the WHOLE import path works across the real process boundary
 * without a model/network:
 *
 *   1) Generate a real 16 kHz mono WAV on disk whose PCM carries the FAKE ASR
 *      "system" marker (so the hermetic streaming fake produces deterministic
 *      text), with trailing silence so the pipeline endpoints + commits a final.
 *   2) Spawn the real `loqui-sidecar` (LOQUI_FAKE_ASR/CHAT/DIARIZER=1 — hermetic).
 *   3) Send ONE `importFile` notification (the same contract main sends).
 *   4) Assert the REAL pipeline emits jobUpdate progress for transcription +
 *      diarization + summary, then ONE importFileDone (ok, speakers, indexText).
 *   5) Assert the sidecar wrote the SAME files a live meeting writes —
 *      transcript.live.md + transcript.jsonl + audio/system.wav — and that the
 *      decoded audio actually became transcript text (decode -> transcript), and
 *      a Speaker N diarized transcript (single stream, never "You"). The
 *      importFileDone.indexText is the searchable text main would index (store).
 *
 * Hermetic: temp LOQUI_DATA_DIR, no real model, no network, no key.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SIDECAR_PROJECT = join(REPO_ROOT, "sidecar");

const require = createRequire(join(REPO_ROOT, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

// Wire-contract event names (stable @loqui/shared literals; hardcoded so the
// smoke does not depend on a freshly-rebuilt shared dist).
const IMPORT_FILE_EVENT = "importFile";
const IMPORT_FILE_DONE_EVENT = "importFileDone";
const JOB_UPDATE_EVENT = "jobUpdate";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;
const IMPORT_TIMEOUT_MS = 30_000;

const AUDIO_SAMPLE_RATE = 16_000;
// The FAKE streaming backend's "system" marker sample (mirror of
// loqui_sidecar/transcription/fake_stream._MARKER_SAMPLE[2]). Filling the WAV
// with it makes the fake decode to the deterministic "They" phrase.
const SYSTEM_MARKER_SAMPLE = 12_000;
// The phrase the fake backend produces for the system marker (mirror of
// fake_stream.PHRASE_BY_MARKER[2]); we assert it lands in the transcript.
const EXPECTED_PHRASE = "the remote meeting audio is playing back clearly";

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

/** Write a 16 kHz mono pcm_s16le WAV of `samples` Int16 to `path`. */
function writeWav(path, samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(AUDIO_SAMPLE_RATE, 24);
  buf.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits/sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  writeFileSync(path, buf);
}

/** Build a synthetic source WAV: ~2 s of marker "speech" + ~0.8 s silence. */
function makeSourceWav(path) {
  const speech = Math.round(AUDIO_SAMPLE_RATE * 2.0);
  const silence = Math.round(AUDIO_SAMPLE_RATE * 0.8);
  const samples = new Int16Array(speech + silence);
  samples.fill(SYSTEM_MARKER_SAMPLE, 0, speech); // marker speech
  // tail stays 0 (silence) so the energy VAD endpoints + the pipeline commits.
  writeWav(path, samples);
}

function startSidecar(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LOQUI_DATA_DIR: dataDir,
        LOQUI_FAKE_ASR: "1",
        LOQUI_FAKE_CHAT: "1",
        LOQUI_FAKE_DIARIZER: "1",
      },
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

async function waitFor(predicate, ms, stepMs = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}

async function main() {
  process.stdout.write("loqui file-import smoke test (FAKE asr/chat/diarizer)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-import-smoke-"));
  const meetingId = randomUUID();
  const meetingDir = join(dataDir, "meetings", meetingId);
  const srcWav = join(dataDir, "source-clip.wav");
  makeSourceWav(srcWav);
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.stdout.write(`  meeting:   ${meetingId}\n`);
  process.stdout.write(`  source:    ${srcWav}\n`);

  // main owns meta.json; the importer (sidecar) writes the transcript + WAV +
  // derived files. Create the meeting dir so the importer writes into it.
  mkdirSync(meetingDir, { recursive: true });

  const livePath = join(meetingDir, "transcript.live.md");
  const structuredPath = join(meetingDir, "transcript.jsonl");
  const systemWavPath = join(meetingDir, "audio", "system.wav");
  const diarizedMdPath = join(meetingDir, "transcript.diarized.md");
  const summaryJsonPath = join(meetingDir, "summary.json");

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

  const jobs = [];
  const dones = [];

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
      if (frame?.type !== "notification") return;
      if (frame.event === JOB_UPDATE_EVENT) jobs.push(frame.data);
      else if (frame.event === IMPORT_FILE_DONE_EVENT) dones.push(frame.data);
    });

    // ---- send the importFile request (fake provider, no key, no HF) ----
    ws.send(
      JSON.stringify({
        type: "notification",
        event: IMPORT_FILE_EVENT,
        data: {
          meetingId,
          filePath: srcWav,
          providerConfig: { provider: "fake" },
          apiKey: null,
          hfToken: null,
          diarizationBackend: "auto",
        },
      }),
    );
    pass("importFile sent");

    // ---- wait for the terminal importFileDone ----
    const gotDone = await waitFor(() => dones.length > 0, IMPORT_TIMEOUT_MS);
    assert(gotDone, "received importFileDone");
    const done = dones[dones.length - 1] ?? {};

    // ---- JobUpdate progress for the REUSED pipeline stages ----
    const jobPairs = new Set(jobs.map((j) => `${j.kind}:${j.state}`));
    assert(jobPairs.has("transcription:running"), "jobUpdate transcription:running");
    assert(jobPairs.has("transcription:done"), "jobUpdate transcription:done");
    assert(jobPairs.has("diarization:done"), "jobUpdate diarization:done (reused post-process)");
    assert(jobPairs.has("summary:done"), "jobUpdate summary:done (reused post-process)");

    // ---- importFileDone payload ----
    assert(done.ok === true, "importFileDone.ok === true");
    assert(done.transcription === "done", `importFileDone.transcription === "done" (${done.transcription})`);
    assert(
      Array.isArray(done.speakers) && done.speakers.length >= 1,
      `importFileDone.speakers (${JSON.stringify(done.speakers)})`,
    );
    assert(
      typeof done.indexText === "string" && done.indexText.length > 0,
      "importFileDone.indexText present (the text main would FTS-index -> store/search)",
    );

    // ---- the SAME files a live meeting writes were produced ----
    assert(existsSync(systemWavPath), "audio/system.wav written (the import single stream)");
    assert(existsSync(structuredPath), "transcript.jsonl written (decode -> transcript)");
    assert(existsSync(livePath), "transcript.live.md written");

    // decode -> transcript: the decoded audio became the expected transcript text.
    const live = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
    const jsonl = existsSync(structuredPath) ? readFileSync(structuredPath, "utf8") : "";
    assert(live.includes(EXPECTED_PHRASE), `transcript text from decoded audio ("${EXPECTED_PHRASE}")`);
    assert(jsonl.includes('"source": "system"') || jsonl.includes('"source":"system"'), "structured record is single-stream (system)");

    // single stream -> diarized as Speaker N, never "You".
    const diarized = existsSync(diarizedMdPath) ? readFileSync(diarizedMdPath, "utf8") : "";
    assert(diarized.includes("Speaker 1"), "diarized transcript labels Speaker N (single stream)");
    assert(!diarized.includes("You"), "diarized transcript has no 'You' label (single stream)");
    assert(existsSync(summaryJsonPath), "summary.json written (reused summary step)");

    // Graceful sidecar shutdown over the same WS (mirrors the supervisor).
    ws.send(JSON.stringify({ type: "request", id: randomUUID(), method: "shutdown" }));
    await delay(200);
  } catch (e) {
    fail(`unexpected error: ${e?.stack ?? e}`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (child && child.exitCode === null) {
      const exited = await waitForExit(child, 2_000);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        await waitForExit(child, 2_000);
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    process.stdout.write(`\nimport smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nimport smoke PASSED\n");
}

main().catch(async (err) => {
  process.stderr.write(`\nimport smoke ERROR: ${err?.stack ?? err}\n`);
  await delay(50);
  process.exit(1);
});
