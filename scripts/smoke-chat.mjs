#!/usr/bin/env node
/**
 * PRD-4 AI-chat-path smoke test (no model, no devices, no Electron, no network,
 * no API key, no CLI).
 *
 * Spawns the REAL Python sidecar via `uv run` with LOQUI_FAKE_CHAT=1 (the sidecar
 * honors this — see loqui_sidecar/providers/fake.py + the production selector in
 * registry.build_selector — by forcing the deterministic, scripted
 * FakeChatProvider into the REAL chat path: WS `chatRequest` notification ->
 * app.py dispatch -> handle_chat -> read the transcript READ-ONLY -> build the
 * grounding context -> stream `chatToken` deltas -> `chatDone`). Points it at a
 * TEMP LOQUI_DATA_DIR so it never touches ~/Loqui.
 *
 * It drives the full chat path end-to-end and asserts:
 *   - a seeded transcript.live.md is read READ-ONLY into the provider context
 *     (the fake provider emits a deterministic `context` marker proving the
 *     transcript reached it as a system message);
 *   - streamed `chatToken` notifications arrive (token-by-token), carry the
 *     request's chatId, and the assembled text echoes the user's question;
 *   - exactly one terminal `chatDone` arrives (no `chatError`);
 *   - THE CROSS-CUTTING INVARIANT: the transcript file is BYTE-IDENTICAL before
 *     and after the chat (the AI never edits the transcript — verified
 *     end-to-end on the live WS path, not just structurally).
 *
 * Flow:
 *   1. seed <tmp>/meetings/<id>/transcript.live.md with distinctive content,
 *      snapshot its bytes.
 *   2. spawn sidecar (LOQUI_FAKE_CHAT=1, LOQUI_DATA_DIR=<tmp>), parse handshake.
 *   3. WS connect with the token; collect every inbound chat notification.
 *   4. send a `chatRequest` asking about the transcript.
 *   5. assert the streamed tokens + the terminal chatDone.
 *   6. assert the transcript file bytes are unchanged.
 *   7. shut the sidecar down (WS shutdown -> kill) BEFORE cleanup.
 *
 * Exits non-zero on the first failure.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SIDECAR_PROJECT = join(REPO_ROOT, "sidecar");

const require = createRequire(join(REPO_ROOT, "apps/desktop/package.json"));
const { WebSocket } = require("ws");

// Wire-contract event names (mirror of @loqui/shared CHAT_EVENT — stable
// contract literals; hardcoded so the smoke does not depend on a freshly-rebuilt
// shared dist).
const CHAT_REQUEST_EVENT = "chatRequest";
const CHAT_TOKEN_EVENT = "chatToken";
const CHAT_DONE_EVENT = "chatDone";
const CHAT_ERROR_EVENT = "chatError";

const HANDSHAKE_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 8_000;

// Distinctive transcript content the user's question will reference.
const TRANSCRIPT_TEXT = [
  "# Meeting transcript",
  "",
  "You: Let's lock the launch date for the Aurora release.",
  "They: Agreed — Aurora ships on the fourteenth, and Priya owns the rollout.",
  "You: Action item: Priya to send the go-live checklist by Friday.",
  "",
].join("\n");

// The question we ask about the seeded transcript.
const USER_QUESTION = "What action items came up about Aurora?";

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

function startSidecar(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--project", SIDECAR_PROJECT, "loqui-sidecar"], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      // LOQUI_FAKE_CHAT=1 is the contract the sidecar honors to stay hermetic
      // (no model, no network, no key, no CLI) while exercising the REAL chat
      // dispatch + handler + provider-selection path.
      env: { ...process.env, LOQUI_DATA_DIR: dataDir, LOQUI_FAKE_CHAT: "1" },
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
  process.stdout.write("loqui AI-chat-path smoke test (FAKE chat provider)\n");
  const dataDir = mkdtempSync(join(tmpdir(), "loqui-chat-smoke-"));
  const meetingId = randomUUID();
  process.stdout.write(`  data root: ${dataDir}\n`);
  process.stdout.write(`  meeting:   ${meetingId}\n`);

  // Seed the transcript the sidecar will read READ-ONLY for grounding.
  const meetingDir = join(dataDir, "meetings", meetingId);
  mkdirSync(meetingDir, { recursive: true });
  const transcriptPath = join(meetingDir, "transcript.live.md");
  writeFileSync(transcriptPath, TRANSCRIPT_TEXT, "utf8");
  const before = readFileSync(transcriptPath); // Buffer snapshot (byte-exact).
  pass("seeded transcript.live.md");

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

  // Collect every inbound chat notification (token / done / error).
  const tokens = [];
  const dones = [];
  const errors = [];
  const chatId = randomUUID();

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
      if (frame.event === CHAT_TOKEN_EVENT) tokens.push(frame.data);
      else if (frame.event === CHAT_DONE_EVENT) dones.push(frame.data);
      else if (frame.event === CHAT_ERROR_EVENT) errors.push(frame.data);
    });

    // Send the chat request asking about the seeded transcript. providerConfig
    // is "fake" and there is NO apiKey — LOQUI_FAKE_CHAT=1 forces the fake
    // provider regardless, so this stays offline.
    ws.send(
      JSON.stringify({
        type: "notification",
        event: CHAT_REQUEST_EVENT,
        data: {
          chatId,
          meetingId,
          messages: [{ role: "user", content: USER_QUESTION }],
          providerConfig: { provider: "fake" },
          apiKey: null,
        },
      }),
    );
    pass("chatRequest sent");

    // Wait for the terminal event (done or error).
    const settled = await waitFor(
      () => dones.length > 0 || errors.length > 0,
      STEP_TIMEOUT_MS,
    );
    assert(settled, "chat stream settled (chatDone/chatError received)");
    // Small drain so any trailing token after done is captured for assertions.
    await delay(100);

    // ---- assertions ----
    assert(errors.length === 0, `no chatError (${errors.map((e) => e?.code).join(",") || "none"})`);
    assert(tokens.length > 0, `received chatToken notifications (${tokens.length})`);
    assert(dones.length === 1, `exactly one chatDone (${dones.length})`);

    // Every token carries the request chatId + a string delta.
    const tokenShapeOk = tokens.every(
      (t) => t && t.chatId === chatId && typeof t.delta === "string",
    );
    assert(tokenShapeOk, "every chatToken has the request chatId + a string delta");

    const assembled = tokens.map((t) => t.delta).join("");
    // The fake provider emits "[fake] context reply to: <first user line>" — the
    // `context` marker proves the READ-ONLY transcript reached the provider as a
    // system message; the echo proves the user's question was carried through.
    assert(
      assembled.includes("[fake]"),
      `streamed text is the fake reply ("${assembled}")`,
    );
    assert(
      assembled.includes("context"),
      "streamed text shows the read-only transcript context reached the provider",
    );
    assert(
      assembled.includes(USER_QUESTION),
      "streamed text references the user's question (round-tripped end-to-end)",
    );

    // chatDone shape: same chatId, assembled text, fake provider/model.
    const done = dones[0];
    assert(done?.chatId === chatId, "chatDone carries the request chatId");
    assert(done?.text === assembled, "chatDone.text equals the concatenated token deltas");
    assert(done?.provider === "fake", `chatDone.provider is "fake" (${done?.provider})`);

    // ---- THE INVARIANT: the transcript file is byte-identical after the chat ----
    const after = readFileSync(transcriptPath);
    assert(
      before.equals(after),
      "transcript.live.md is BYTE-IDENTICAL after the chat (the AI never edits it)",
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
    // Shut the sidecar down BEFORE cleanup so nothing holds the temp dir.
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
    process.stdout.write(`\nchat smoke FAILED: ${failures} assertion(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write("\nchat smoke PASSED\n");
}

main().catch(async (err) => {
  process.stderr.write(`\nchat smoke ERROR: ${err?.stack ?? err}\n`);
  await delay(50);
  process.exit(1);
});
