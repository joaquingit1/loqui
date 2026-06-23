import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the Electron full-app E2E.
 *
 * These tests launch the REAL built Electron app (out/main/index.js) against the
 * fake-ASR sidecar and exercise the renderer -> preload(contextBridge) -> main
 * IPC -> sidecar(WS) seam that nothing else covers automatically. They are NOT
 * unit tests (vitest, *.test.ts) — they live in e2e/ and match *.e2e.ts. Build
 * the app first (`pnpm --filter @loqui/desktop build`).
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // Electron cold start + uv-spawned sidecar handshake needs headroom.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // GUI launch in CI can be occasionally flaky; retry there, never locally.
  retries: process.env.CI ? 2 : 0,
  // One Electron app at a time (the app owns a fixed loopback sidecar).
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
});
