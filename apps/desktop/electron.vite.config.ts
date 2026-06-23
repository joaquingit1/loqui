import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite config. Three build targets:
 *   - main:     Node main process (src/main/index.ts)
 *   - preload:  contextBridge preload (src/preload/index.ts)
 *   - renderer: React app (src/renderer/index.html)
 *
 * better-sqlite3, ws and electron are externalized from the main bundle
 * (native / node modules); @loqui/shared is bundled.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@loqui/shared"] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@loqui/shared"] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@loqui/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
