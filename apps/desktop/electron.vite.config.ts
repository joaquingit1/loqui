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
        // A sandboxed preload (webPreferences.sandbox: true) MUST be CommonJS —
        // Electron cannot load an ESM (.mjs) preload in a sandbox. The package is
        // "type":"module", so force CJS output with an explicit .cjs extension
        // and load it from main as ../preload/index.cjs.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
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
