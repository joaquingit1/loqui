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

test("the PRD-6 speaker-names indicator renders + the status IPC round-trips (absent extension degrades gracefully)", async () => {
  // PRD-6 is WIRED into the running app: the status IPC handler is registered
  // (registerSpeakerNamesIpc) so window.loqui.speakerNames.status() round-trips
  // through the real loopback WS server. With no extension connected in the E2E,
  // it reports "disconnected" — proving the end-to-end graceful-degradation path
  // (the meeting would still diarize with generic `Speaker N` labels).
  const status = await page.evaluate(async () => {
    try {
      const api = (
        window as unknown as {
          loqui?: { speakerNames?: { status?: () => Promise<{ state?: string } | null> } };
        }
      ).loqui;
      if (typeof api?.speakerNames?.status !== "function") return { error: "no bridge" };
      return await api.speakerNames.status();
    } catch (e) {
      return { error: String(e) };
    }
  });
  // The invoke must NOT reject (the handler exists) and reports a disconnected
  // resting state (no extension paired in the headless E2E).
  expect(status && typeof status === "object").toBe(true);
  expect((status as { error?: string }).error).toBeUndefined();
  expect((status as { state?: string }).state).toBe("disconnected");

  // The indicator is mounted under Settings and shows the degraded copy.
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("speakernames-status")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("speakernames-pill")).toHaveAttribute("data-state", "disconnected");
});
