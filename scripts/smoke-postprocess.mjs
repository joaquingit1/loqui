#!/usr/bin/env node
/**
 * PRD-5 post-process-path smoke test (no model, no torch, no pyannote, no HF
 * token, no devices, no Electron, no network, no API key).
 *
 * Spawns the REAL Python sidecar via `uv run` with the three hermetic contracts
 * the sidecar honors to stay offline + deterministic while exercising the REAL
 * post-process dispatch path end-to-end:
 *   - LOQUI_FAKE_ASR=1     — fake source-aware streaming ASR (no model)
 *   - LOQUI_FAKE_CHAT=1    — fake chat/summary provider (no key, no network)
 *   - LOQUI_FAKE_DIARIZER=1 — deterministic FakeDiarizer (no torch/pyannote/HF)
 * Points it at a TEMP LOQUI_DATA_DIR so it never touches ~/Loqui.
 *
 * The post-process pipeline is normally driven by MAIN (which owns the SQLite
 * store + FTS index + meta.json + the structured transcript.jsonl). This smoke
 * is sidecar-only (mirrors smoke-chat / smoke-transcription — no Electron, no
 * main), so it plays MAIN's seam by hand: it drives a real meeting to write the
 * WAVs, seeds the READ-ONLY structured transcript.jsonl + transcript.live.md
 * that alignment reads, then sends ONE `postProcess` WS notification and asserts
 * the sidecar's REAL run_postprocess output:
 *   - JobUpdate progress (running -> done) for BOTH the diarization + summary
 *     jobs (kind "diarization" / "summary");
 *   - <id>/transcript.diarized.{json,md} written, with "You" (mic) + >= 2
 *     "Speaker N" labels (the system "They" stream, diarized into >= 2 speakers);
 *   - <id>/summary.json written (the structured Summary the sidecar persists;
 *     summary.md + the FTS index are MAIN's derived artifacts — here we assert
 *     the `indexText` MAIN would fold into FTS is non-empty + searchable, i.e.
 *     contains the seeded transcript's distinctive content);
 *   - exactly one terminal `postProcessDone` reporting diarization "done",
 *     summary "done", a non-empty `speakers` list (>= 2), and a backend/provider;
 *   - THE CROSS-CUTTING INVARIANT: transcript.live.md AND transcript.jsonl are
 *     BYTE-IDENTICAL before and after the whole pipeline (diarization + summary
 *     write only the SEPARATE derived files; the live transcript is never
 *     touched).
 *
 * Flow:
 *   1. spawn sidecar (3 fake flags + temp LOQUI_DATA_DIR), parse handshake.
 *   2. WS connect; drive a real meeting (audioStart -> stream synthetic mic +
 *      system marker PCM -> audioStop) so the sidecar writes the WAVs + emits
 *      audioFinalized.
 *   3. seed the structured transcript.jsonl (mic + system segments with the
 *      timestamps alignment overlaps against) + transcript.live.md; snapshot
 *      both files' bytes.
 *   4. send `postProcess`; collect JobUpdate + postProcessDone notifications.
 *   5. assert the jobs, the diarized files, summary.json, the done payload.
 *   6. assert transcript.live.md + transcript.jsonl are byte-identical.
 *   7. shut the sidecar down (WS shutdown -> kill) BEFORE cleanup.
 *
 * Exits non-zero on the first failure.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
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

// Wire-contract event names (stable @loqui/shared literals; hardcoded so the
// smoke does not depend on a freshly-rebuilt shared dist).
const POSTPROCESS_REQUEST_EVENT = "postProcess";
const POSTPROCESS_DONE_EVENT = "postProcessDone";
const JOB_UPDATE_EVENT = "jobUpdate";
const AUDIO_FINALIZED_EVENT = "audioFinalized";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;
const POSTPROCESS_TIMEOUT_MS = 30_000;

// 20 ms frames @ 16 kHz mono = 320 samples/frame.
const FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * 20) / 1000; // 320
const SPEECH_FRAMES = 60; // ~1.2 s of "speech" per source -> non-trivial WAV
const SILENCE_FRAMES = 20; // trailing silence

// Source markers (mirror loqui_sidecar/transcription/fake_stream._MARKER_SAMPLE).
const MARKER_SAMPLE = { mic: 6000, system: 12000 };

// Distinctive content seeded into the live + structured transcript. The summary
// (fake provider) folds the transcript into `indexText`; we assert the index
// text carries this distinctive token so MAIN's FTS would find it.
const DISTINCTIVE = "Aurora";

// Structured transcript.jsonl records alignment overlaps the diarizer turns
// against: one mic segment ("You") + several system segments ("They" -> diarized
// into >= 2 speakers). Timestamps in SECONDS.
const STRUCTURED_SEGMENTS = [
  { segId: "s-mic-1", source: "mic", tStart: 0.0, tEnd: 2.0, text: `You: Let's lock the ${DISTINCTIVE} launch date.` },
  { segId: "s-sys-1", source: "system", tStart: 2.0, tEnd: 4.0, text: `They: ${DISTINCTIVE} ships on the fourteenth.` },
  { segId: "s-sys-2", source: "system", tStart: 4.0, tEnd: 6.0, text: "They: Priya owns the rollout." },
  { segId: "s-sys-3", source: "system", tStart: 6.0, tEnd: 8.0, text: "They: I'll send the checklist by Friday." },
  { segId: "s-sys-4", source: "system", tStart: 8.0, tEnd: 10.0, text: "They: Sounds good to everyone." },
];

const LIVE_TRANSCRIPT_TEXT =
  ["# Meeting transcript", "", ...STRUCTURED_SEGMENTS.map((s) => s.text), ""].join("\n");

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
  const tsMs = ((frameIndex * FRAME_SAMPLES) / AUDIO_SAMPLE_RATE) * 1000;
  return encodeFrame(source, frameIndex, tsMs, pcm);
}

function startSidecar(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      // The three fake contracts keep the WHOLE post-process path hermetic
      // (no model, no torch/pyannote, no HF token, no network, no key) while
      // exercising the REAL dispatch + run_postprocess + diarization + alignment
      // + summary path.
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
      finish(
        new Error(`handshake not received within ${HANDSHAKE_TIMEOUT_MS}ms; stderr:\n${stderr}`),
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

/** Wait until `predicate()` is true or `ms` elapses. */
async function waitFor(predicate, ms, stepMs = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}

async function main() {
  process.stdout.write("loqui post-process-path smoke test (FAKE asr/chat/diarizer)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-postprocess-smoke-"));
  const meetingId = randomUUID();
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.stdout.write(`  meeting:   ${meetingId}\n`);

  const meetingDir = join(dataDir, "meetings", meetingId);
  const livePath = join(meetingDir, "transcript.live.md");
  const structuredPath = join(meetingDir, "transcript.jsonl");
  const diarizedJsonPath = join(meetingDir, "transcript.diarized.json");
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
  const finalized = new Set();

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
      else if (frame.event === POSTPROCESS_DONE_EVENT) dones.push(frame.data);
      else if (frame.event === AUDIO_FINALIZED_EVENT && frame.data?.source)
        finalized.add(frame.data.source);
    });

    // ---- 1) drive a real meeting so the sidecar writes the WAVs ----
    ws.send(JSON.stringify(audioControl("audioStart", meetingId, "system")));
    ws.send(JSON.stringify(audioControl("audioStart", meetingId, "mic")));
    await delay(150);
    for (let i = 0; i < SPEECH_FRAMES; i++) {
      await sendBinary(ws, frameFor("system", i, { silence: false }));
      await sendBinary(ws, frameFor("mic", i, { silence: false }));
    }
    for (let i = SPEECH_FRAMES; i < SPEECH_FRAMES + SILENCE_FRAMES; i++) {
      await sendBinary(ws, frameFor("system", i, { silence: true }));
      await sendBinary(ws, frameFor("mic", i, { silence: true }));
    }
    await delay(300);
    ws.send(JSON.stringify(audioControl("audioStop", meetingId, "mic")));
    ws.send(JSON.stringify(audioControl("audioStop", meetingId, "system")));
    pass("drove a meeting (audioStart -> stream mic+system PCM -> audioStop)");

    // Wait for the audioFinalized signal for BOTH sources (main waits on this
    // before sending postProcess — system.wav must be flushed for diarization).
    const bothFinalized = await waitFor(
      () => finalized.has("mic") && finalized.has("system"),
      STEP_TIMEOUT_MS,
    );
    assert(bothFinalized, `audioFinalized for both sources (${[...finalized].join(",") || "none"})`);
    assert(
      existsSync(join(meetingDir, "audio", "system.wav")),
      "audio/system.wav written (the diarized 'They' stream)",
    );

    // ---- 2) seed the READ-ONLY structured + live transcript (MAIN's job) ----
    mkdirSync(meetingDir, { recursive: true });
    const jsonl = STRUCTURED_SEGMENTS.map((s) => JSON.stringify(s)).join("\n") + "\n";
    writeFileSync(structuredPath, jsonl, "utf8");
    writeFileSync(livePath, LIVE_TRANSCRIPT_TEXT, "utf8");
    const liveBefore = readFileSync(livePath); // byte-exact snapshots
    const structuredBefore = readFileSync(structuredPath);
    pass("seeded transcript.jsonl + transcript.live.md (snapshotted)");

    // ---- 3) send the postProcess request (fake provider, no key, no HF) ----
    ws.send(
      JSON.stringify({
        type: "notification",
        event: POSTPROCESS_REQUEST_EVENT,
        data: {
          meetingId,
          providerConfig: { provider: "fake" },
          apiKey: null,
          hfToken: null,
          regenerateSummary: false,
          rediarize: false,
        },
      }),
    );
    pass("postProcess sent");

    const settled = await waitFor(() => dones.length > 0, POSTPROCESS_TIMEOUT_MS);
    assert(settled, "postProcessDone received");
    await delay(150); // drain any trailing job update

    // ---- assertions: JobUpdate progress for diarization + summary ----
    const byKind = { diarization: [], summary: [] };
    for (const j of jobs) {
      if (j && (j.kind === "diarization" || j.kind === "summary")) byKind[j.kind].push(j);
    }
    for (const kind of ["diarization", "summary"]) {
      const ks = byKind[kind];
      assert(ks.length > 0, `${kind}: got JobUpdate progress (${ks.length})`);
      const states = ks.map((j) => j.state);
      assert(states.includes("running"), `${kind}: emitted state "running"`);
      assert(states.includes("done"), `${kind}: emitted state "done"`);
      assert(
        states.indexOf("running") < states.lastIndexOf("done"),
        `${kind}: running precedes done`,
      );
    }

    // ---- diarized files exist, with "You" + >= 2 "Speaker N" labels ----
    assert(existsSync(diarizedJsonPath), "transcript.diarized.json written");
    assert(existsSync(diarizedMdPath), "transcript.diarized.md written");
    let diarized;
    try {
      diarized = JSON.parse(readFileSync(diarizedJsonPath, "utf8"));
    } catch (e) {
      fail(`transcript.diarized.json is valid JSON (${e?.message ?? e})`);
      diarized = { segments: [] };
    }
    const segs = Array.isArray(diarized.segments) ? diarized.segments : [];
    const labels = segs.map((s) => s.speaker);
    assert(labels.includes("You"), `diarized has a "You" (mic) label`);
    const speakerLabels = new Set(labels.filter((l) => typeof l === "string" && l.startsWith("Speaker")));
    assert(
      speakerLabels.size >= 2,
      `diarized has >= 2 "Speaker N" labels (${[...speakerLabels].sort().join(",") || "none"})`,
    );
    // The mic segment is "You", never a "Speaker N" (mic is known to be You).
    const micSeg = segs.find((s) => s.segId === "s-mic-1");
    assert(micSeg && micSeg.speaker === "You", `mic segment labeled "You" (${micSeg?.speaker})`);

    // The diarized .md renders the speaker labels.
    const md = readFileSync(diarizedMdPath, "utf8");
    assert(md.includes("You"), "diarized .md renders the You label");
    assert(
      [...speakerLabels].some((l) => md.includes(l)),
      "diarized .md renders a Speaker N label",
    );

    // ---- summary.json written (the sidecar's structured Summary) ----
    assert(existsSync(summaryJsonPath), "summary.json written");

    // ---- exactly one postProcessDone with the expected payload ----
    assert(dones.length === 1, `exactly one postProcessDone (${dones.length})`);
    const done = dones[0];
    assert(done?.meetingId === meetingId, "postProcessDone carries the meeting id");
    assert(done?.diarization === "done", `postProcessDone.diarization is "done" (${done?.diarization})`);
    assert(done?.summary === "done", `postProcessDone.summary is "done" (${done?.summary})`);
    assert(
      Array.isArray(done?.speakers) && done.speakers.length >= 2,
      `postProcessDone.speakers has >= 2 (${(done?.speakers || []).join(",") || "none"})`,
    );
    assert(
      typeof done?.diarizationBackend === "string" && done.diarizationBackend.length > 0,
      `postProcessDone.diarizationBackend present (${done?.diarizationBackend})`,
    );
    assert(
      typeof done?.summaryProvider === "string" && done.summaryProvider.length > 0,
      `postProcessDone.summaryProvider present (${done?.summaryProvider})`,
    );
    // The index text MAIN would fold into FTS is non-empty + carries the seeded
    // distinctive content (so the meeting is searchable post-process).
    assert(
      typeof done?.indexText === "string" && done.indexText.length > 0,
      "postProcessDone.indexText is non-empty (MAIN's FTS payload)",
    );
    assert(
      done.indexText.includes(DISTINCTIVE),
      `indexText is searchable for the seeded content ("${DISTINCTIVE}")`,
    );
    // Secrets never leak into the terminal event.
    const doneStr = JSON.stringify(done);
    assert(!/api[_-]?key|hf[_-]?token/i.test(doneStr), "postProcessDone leaks no secret keys");

    // ---- THE INVARIANT: live + structured transcript byte-identical ----
    const liveAfter = readFileSync(livePath);
    const structuredAfter = readFileSync(structuredPath);
    assert(
      liveBefore.equals(liveAfter),
      "transcript.live.md is BYTE-IDENTICAL after post-process (never edited)",
    );
    assert(
      structuredBefore.equals(structuredAfter),
      "transcript.jsonl is BYTE-IDENTICAL after post-process (never edited)",
    );

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
    process.stdout.write(`\npostprocess smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\npostprocess smoke PASSED\n");
}

main().catch(async (err) => {
  process.stderr.write(`\npostprocess smoke ERROR: ${err?.stack ?? err}\n`);
  await delay(50);
  process.exit(1);
});
