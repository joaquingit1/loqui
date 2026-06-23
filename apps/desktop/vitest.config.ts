import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Single config; environment is chosen per-file by path:
 *   - src/renderer/** -> jsdom (React component tests)
 *   - everything else -> node  (main / store / supervisor tests)
 *
 * Tests MUST be hermetic — they set LOQUI_DATA_DIR to a temp dir and never
 * touch the real ~/Loqui.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@loqui/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    environmentMatchGlobs: [["src/renderer/**", "jsdom"]],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
