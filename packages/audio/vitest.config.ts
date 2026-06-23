import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Hermetic node-environment tests for the pure DSP + frame codec. No browser
 * APIs, no audio devices: every test drives the pure functions with synthetic
 * Float32/Int16 buffers.
 *
 * `@loqui/shared` is aliased to its TS source so the codec tests exercise the
 * canonical encoder/decoder without depending on a freshly built dist.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@loqui/shared": resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
