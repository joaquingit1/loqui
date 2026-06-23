#!/usr/bin/env node
/**
 * PRD-0 foundation smoke test (no display / Electron needed).
 *
 * Spawns the real Python sidecar via `uv run`, reads + parses its single stdout
 * handshake line, and exercises the cross-process contract end to end:
 *
 *   1. handshake line is valid JSON {port, token, protocolVersion} and the
 *      protocolVersion matches @loqui/shared's PROTOCOL_VERSION.
 *   2. GET /health WITH the token -> 200 + {status:"ok", ...}.
 *   3. GET /health WITHOUT the token -> rejected (401).
 *   4. WS connect (with token) -> send the EXACT request envelope the real
 *      SidecarClient produces ({type,id,method}, NO token) -> expect a `pong`;
 *      then send a token-bearing variant and assert the sidecar REJECTS it
 *      (invalid_frame), proving the client must not embed the token.
 *   5. Send one VALID and one INVALID `audioStart` notification; the sidecar
 *      validates them against packages/shared/schema (valid -> no error frame,
 *      invalid -> an `invalid_frame` error frame).
 *   6. Send `shutdown` -> expect the process to exit within a timeout.
 *
 * Exits non-zero on the first failure. This is the runnable acceptance gate for
 * the handshake / token / schema / shutdown seams between the units.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SIDECAR_PROJECT = join(REPO_ROOT, "sidecar");

// Hermetic data root: PRD-1 made the sidecar's audioStart open a REAL WAV
// writer (it was a no-op in PRD-0), and this smoke sends a valid audioStart. If
// LOQUI_DATA_DIR is unset the sidecar falls back to ~/Loqui and writes a stray
// mic.wav into the user's real home (and, on a case-insensitive ~/Loqui==repo
// box, into the working tree). Pin every spawned sidecar at a temp dir and
// remove it on exit — mirrors scripts/smoke-audio.mjs.
const DATA_DIR = mkdtempSync(join(tmpdir(), "loqui-foundation-smoke-"));
function cleanupDataDir() {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// `ws` is a dependency of @loqui/desktop, not hoisted to the repo root. Anchor
// the resolution there so this works on CI's Node 20 too (built-in WebSocket is
// not stable until 22).
const require = createRequire(join(REPO_ROOT, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

// PROTOCOL_VERSION is the single source of truth: import the built @loqui/shared
// output directly (run `pnpm --filter @loqui/shared build` first if missing).
const SHARED_DIST = join(REPO_ROOT, "packages/shared/dist/index.js");
let PROTOCOL_VERSION;
try {
  ({ PROTOCOL_VERSION } = await import(new URL(`file://${SHARED_DIST}`).href));
} catch (e) {
  process.stderr.write(
    `\ncould not import @loqui/shared from ${SHARED_DIST}\n` +
      "build it first: corepack pnpm --filter @loqui/shared build\n",
  );
  process.exit(1);
}

const HANDSHAKE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const STEP_TIMEOUT_MS = 8_000;

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
 * Build the EXACT request envelope shape the real SidecarClient sends
 * (apps/desktop/src/main/sidecar/client.ts request()): {type,id,method,params?}
 * with NO token. Kept in lockstep with the client so the smoke test exercises
 * the real wire frame and would catch a re-introduced token field.
 */
function clientRequestEnvelope(id, method, params) {
  return {
    type: "request",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

/**
 * Spawn the sidecar and resolve once its handshake line is parsed.
 *
 * Production (the supervisor) spawns with stdin as a pipe it holds open for the
 * child's lifetime; the open pipe is the parent-liveness channel and EOF on it
 * triggers graceful shutdown. We mirror that here (stdio[0]="pipe") and never
 * end child.stdin until we deliberately exercise the stdin-EOF path.
 */
function startSidecar() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"],
      {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        // Keep the sidecar's WAV writes inside a temp dir, never ~/Loqui, and
        // force the hermetic FAKE ASR backend (PRD-2): this foundation gate
        // exercises the control wire, NOT real transcription, so it must never
        // pull in faster-whisper / download a model (which would slow shutdown
        // and reach the network). The transcription path has its own smoke.
        env: { ...process.env, LOQUI_DATA_DIR: DATA_DIR, LOQUI_FAKE_ASR: "1" },
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
      } catch (e) {
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
      if (!settled) finish(new Error(`sidecar exited (code ${code}) before handshake; stderr:\n${stderr}`));
    });

    child._stderrRef = () => stderr;
  });
}

/** GET /health, returning {status, body}. */
async function getHealth(port, token) {
  const url =
    token === null
      ? `http://127.0.0.1:${port}/health`
      : `http://127.0.0.1:${port}/health?token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
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

/**
 * Send a frame and wait for the next JSON message, or for a quiet window to
 * elapse (used to assert that a VALID notification draws NO response).
 */
function sendAndAwait(ws, frame, { expectSilence = false, quietMs = 600 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const onMessage = (data) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        resolve(JSON.parse(data.toString("utf8")));
      } catch (e) {
        reject(new Error(`non-JSON WS message: ${data}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    const timer = setTimeout(
      () => {
        if (done) return;
        done = true;
        cleanup();
        if (expectSilence) resolve(null);
        else reject(new Error("timed out waiting for WS reply"));
      },
      expectSilence ? quietMs : STEP_TIMEOUT_MS,
    );
    ws.on("message", onMessage);
    ws.send(JSON.stringify(frame));
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
  process.stdout.write("loqui foundation smoke test\n");
  process.stdout.write(`  expected protocolVersion: ${PROTOCOL_VERSION}\n`);

  const { child, handshake } = await startSidecar();

  let ws = null;
  try {
    // 1. Handshake shape + protocol version.
    assert(
      Number.isInteger(handshake.port) && handshake.port > 0,
      `handshake.port is a positive integer (${handshake.port})`,
    );
    assert(
      typeof handshake.token === "string" && handshake.token.length > 0,
      "handshake.token is a non-empty string",
    );
    assert(
      handshake.protocolVersion === PROTOCOL_VERSION,
      `handshake.protocolVersion (${handshake.protocolVersion}) matches @loqui/shared`,
    );

    const { port, token } = handshake;

    // 2. GET /health WITH the token.
    const okHealth = await getHealth(port, token);
    assert(
      okHealth.status === 200 && okHealth.body && okHealth.body.status === "ok",
      `GET /health with token -> 200 ok (got ${okHealth.status})`,
    );
    assert(
      okHealth.body && okHealth.body.protocolVersion === PROTOCOL_VERSION,
      "GET /health reports the matching protocolVersion",
    );

    // 3. GET /health WITHOUT the token is rejected.
    const noTokenHealth = await getHealth(port, null);
    assert(
      noTokenHealth.status === 401,
      `GET /health without token -> rejected (got ${noTokenHealth.status})`,
    );

    // 4. WS ping -> pong, using the EXACT envelope the real SidecarClient
    //    produces (see apps/desktop/src/main/sidecar/client.ts request()):
    //    {type:"request", id, method} with NO token field. Building it the same
    //    way the client does is what regression-guards the token-rejection bug.
    ws = await connectWs(port, token);
    pass("WS connected with token");
    const pingEnvelope = clientRequestEnvelope("smoke-ping-1", "ping");
    assert(
      !("token" in pingEnvelope),
      "client-shaped request envelope carries NO token field",
    );
    const pong = await sendAndAwait(ws, pingEnvelope);
    assert(
      pong &&
        pong.type === "response" &&
        pong.id === "smoke-ping-1" &&
        pong.ok === true &&
        pong.result &&
        pong.result.pong === true,
      "WS ping -> pong response (token-less, contract-shaped envelope)",
    );

    // 4b. A token-bearing request MUST be rejected by the sidecar's
    //     WsEnvelope validation (additionalProperties:false). This is the exact
    //     production bug that the old (token-embedding) client triggered.
    const tokenBearing = { ...clientRequestEnvelope("smoke-ping-2", "ping"), token };
    const rejected = await sendAndAwait(ws, tokenBearing);
    assert(
      rejected &&
        rejected.type === "error" &&
        rejected.ok === false &&
        rejected.error &&
        rejected.error.code === "invalid_frame",
      "token-bearing request rejected as invalid_frame (client must not embed the token)",
    );

    // 5a. VALID audioStart notification -> no error frame.
    const validAudio = {
      type: "notification",
      event: "audioStart",
      data: {
        meetingId: "11111111-1111-1111-1111-111111111111",
        source: "mic",
        sampleRate: 16000,
        channels: 1,
        encoding: "pcm_s16le",
      },
    };
    const validReply = await sendAndAwait(ws, validAudio, { expectSilence: true });
    assert(
      validReply === null,
      "VALID audioStart accepted (no error frame from sidecar schema validation)",
    );

    // 5b. INVALID audioStart notification -> error frame.
    const invalidAudio = {
      type: "notification",
      event: "audioStart",
      data: {
        // missing required `source`; bad sampleRate const.
        meetingId: "not-a-uuid",
        sampleRate: 44100,
      },
    };
    const invalidReply = await sendAndAwait(ws, invalidAudio);
    assert(
      invalidReply &&
        invalidReply.type === "error" &&
        invalidReply.ok === false,
      "INVALID audioStart rejected by sidecar schema validation (error frame)",
    );

    // 6. shutdown -> process exits.
    const shutdownReply = await sendAndAwait(
      ws,
      clientRequestEnvelope("smoke-shutdown-1", "shutdown"),
    );
    assert(
      shutdownReply &&
        shutdownReply.type === "response" &&
        shutdownReply.result &&
        shutdownReply.result.shuttingDown === true,
      "shutdown request acknowledged",
    );

    const exited = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
    assert(exited, `sidecar exited within ${SHUTDOWN_TIMEOUT_MS}ms of shutdown`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await waitForExit(child, 2_000);
    }
  }

  // 7. Parent-exit detection: production spawns the sidecar with stdin as a
  //    pipe the parent holds open; closing it (EOF) is the signal that the
  //    parent is gone and must trigger graceful shutdown. Verify that the
  //    sidecar stays alive while stdin is open, then exits when we end it.
  await stdinEofShutdownScenario();

  cleanupDataDir();

  if (failures > 0) {
    process.stdout.write(`\nsmoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nsmoke PASSED\n");
}

/**
 * Spawn a fresh sidecar exactly as production does (stdin = pipe held open),
 * confirm it survives past the handshake while stdin stays open, then close
 * stdin and assert the sidecar shuts down gracefully on the resulting EOF.
 */
async function stdinEofShutdownScenario() {
  let child;
  try {
    ({ child } = await startSidecar());
  } catch (e) {
    fail(`stdin-EOF scenario: sidecar failed to start (${e?.message ?? e})`);
    return;
  }

  // It must NOT self-terminate while we hold stdin open (the old "ignore"/
  // /dev/null bug exited ~150ms after the handshake).
  const exitedEarly = await waitForExit(child, 1_000);
  assert(
    !exitedEarly,
    "sidecar stays alive while parent holds stdin open (no premature stdin-EOF shutdown)",
  );

  // Now act as a quitting parent: close stdin -> EOF -> graceful shutdown.
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  const exitedOnEof = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
  assert(exitedOnEof, "sidecar shuts down gracefully on stdin EOF (parent-exit detection)");

  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await waitForExit(child, 2_000);
  }
}

main().catch(async (err) => {
  process.stderr.write(`\nsmoke ERROR: ${err?.stack ?? err}\n`);
  cleanupDataDir();
  await delay(50);
  process.exit(1);
});
