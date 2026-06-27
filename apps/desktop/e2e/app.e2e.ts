/**
 * Full-app Electron E2E (PRD test-gap closer).
 *
 * Launches the REAL built app (out/main/index.js) with the hermetic fake-ASR
 * sidecar (LOQUI_FAKE_ASR=1) and a temp data root, then asserts the seam that no
 * unit/smoke test exercises: the renderer actually loads, the preload
 * contextBridge exposes window.loqui, and a call through it round-trips
 * renderer -> preload -> main IPC -> the uv-spawned sidecar over the real WS.
 *
 * The supervisor uses the dev `uv run` launch because the app is not packaged
 * here (app.isPackaged === false), so uv must be on PATH (it is, in CI + dev).
 *
 * NOT covered (still manual on a real machine): real mic/system AUDIO capture
 * (getUserMedia/getDisplayMedia need real devices + the macOS screen-recording
 * grant), which cannot run headlessly.
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const MAIN_ENTRY = join(DESKTOP_ROOT, "out", "main", "index.js");

let app: ElectronApplication;
let page: Page;
let dataDir: string;

test.beforeAll(async () => {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(
      `built main not found at ${MAIN_ENTRY} — run \`pnpm --filter @loqui/desktop build\` first`,
    );
  }
  dataDir = mkdtempSync(join(tmpdir(), "loqui-e2e-"));
  app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: DESKTOP_ROOT,
    env: { ...process.env, LOQUI_DATA_DIR: dataDir, LOQUI_FAKE_ASR: "1", LOQUI_E2E: "1" },
  });
  page = await app.firstWindow();
  // The "Meeting Detected" popup is a SECOND BrowserWindow created at startup;
  // its open order vs. the main window can race across OSes. Always drive the
  // MAIN app window (notification.html → the popup; index.html → the main app).
  if (page.url().includes("notification")) {
    page = await app.waitForEvent("window", {
      predicate: (w) => !w.url().includes("notification"),
    });
  }
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("the app window opens and the React renderer mounts", async () => {
  // React mounted content into #root (the renderer bundle actually loaded).
  await expect
    .poll(() => page.evaluate(() => document.getElementById("root")?.childElementCount ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
});

test("the preload contextBridge exposes a minimal window.loqui (no Node leak)", async () => {
  const surface = await page.evaluate(() => {
    const api = (window as unknown as { loqui?: Record<string, unknown> }).loqui;
    return {
      hasPing: typeof api?.ping === "function",
      hasHealth: typeof api?.getSidecarHealth === "function",
      // contextIsolation must NOT leak Node primitives into the renderer.
      leakedRequire: typeof (window as unknown as { require?: unknown }).require !== "undefined",
      leakedProcess: typeof (window as unknown as { process?: unknown }).process !== "undefined",
    };
  });
  expect(surface.hasPing).toBe(true);
  expect(surface.hasHealth).toBe(true);
  expect(surface.leakedRequire).toBe(false);
  expect(surface.leakedProcess).toBe(false);
});

test("the chat bridge is exposed on window.loqui (PRD-4 chat wire is on the live tree)", async () => {
  // Regression guard: the chat feature's bridge must reach the renderer. The
  // ChatPanel itself only mounts during an active meeting (which needs real
  // audio capture, not available headlessly), but the bridge presence proves
  // the preload chat surface is wired into the running app.
  const chat = await page.evaluate(() => {
    const api = (window as unknown as { loqui?: { chat?: Record<string, unknown> } }).loqui;
    const c = api?.chat;
    return {
      hasSend: typeof c?.send === "function",
      hasOnStream: typeof c?.onStream === "function",
      hasGetProviderSettings: typeof c?.getProviderSettings === "function",
      hasSetApiKey: typeof c?.setApiKey === "function",
    };
  });
  expect(chat.hasSend).toBe(true);
  expect(chat.hasOnStream).toBe(true);
  expect(chat.hasGetProviderSettings).toBe(true);
  expect(chat.hasSetApiKey).toBe(true);
});

test("sidecar reaches healthy + ping round-trips through the real IPC/WS seam", async () => {
  // The main process spawns the sidecar (uv run) and connects; poll the REAL
  // bridge until it reports healthy.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          try {
            const h = await (
              window as unknown as { loqui: { getSidecarHealth: () => Promise<{ status?: string } | null> } }
            ).loqui.getSidecarHealth();
            return h?.status ?? null;
          } catch {
            return null;
          }
        }),
      { timeout: 60_000, intervals: [500] },
    )
    .toBe("ok");

  const pong = await page.evaluate(
    async () =>
      (window as unknown as { loqui: { ping: () => Promise<{ ok: boolean; latencyMs: number }> } }).loqui.ping(),
  );
  expect(pong.ok).toBe(true);
  expect(typeof pong.latencyMs).toBe("number");
});

test("the capture AudioWorklet bundle loads + registers (regression: addModule must not 404)", async () => {
  // The worklet generates the PCM frames; if its bundle isn't built/served,
  // addModule throws AbortError "The user aborted a request." and recording
  // silently produces nothing. Verify the real bundle loads + the processor
  // ("loqui-capture") registers — exercised through the actual built renderer.
  const result = await page.evaluate(async () => {
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule(new URL("capture-worklet.js", document.baseURI).href);
      const node = new AudioWorkletNode(ctx, "loqui-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { source: "mic", startTimeMs: 0 },
      });
      const ok = !!node;
      await ctx.close();
      return { ok };
    } catch (e) {
      return { ok: false, name: (e as Error).name, message: (e as Error).message };
    }
  });
  expect(result.ok).toBe(true);
});

test("a transcriptSegment pushed from main reaches window.loqui.onTranscriptSegment (live push wired)", async () => {
  // The live transcript depends on main → renderer IPC delivery of segments
  // (the one seam not covered by the renderer-only LiveTranscript unit tests).
  // Register a real listener, push a segment from MAIN on the real channel, and
  // assert it arrives — proving the live push reaches the renderer.
  await page.evaluate(() => {
    (window as unknown as { __lastSeg: unknown }).__lastSeg = null;
    (
      window as unknown as {
        loqui: { onTranscriptSegment: (cb: (s: unknown) => void) => () => void };
      }
    ).loqui.onTranscriptSegment((s) => {
      (window as unknown as { __lastSeg: unknown }).__lastSeg = s;
    });
  });

  await app.evaluate(({ BrowserWindow }) => {
    // Target the MAIN window specifically — once the "Meeting Detected" popup
    // exists, getAllWindows()[0] is not guaranteed to be the main app window
    // (and the listener above lives in the main window).
    const wins = BrowserWindow.getAllWindows();
    const win = wins.find((w) => !w.webContents.getURL().includes("notification")) ?? wins[0];
    win?.webContents.send("loqui:transcriptSegment", {
      meetingId: "e2e-meeting",
      source: "mic",
      text: "hello from main",
      tStart: 0,
      tEnd: 1,
      status: "final",
      segId: "e2e-meeting:mic:0",
    });
  });

  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __lastSeg: { text?: string } | null }).__lastSeg?.text ?? null,
      ),
    )
    .toBe("hello from main");
});
