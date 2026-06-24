import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * PRD-6 extension test config. HERMETIC + node-only — there is NO DOM library
 * (jsdom/happy-dom) available to this package and we install nothing, so the
 * selector tests run against a tiny hand-rolled fixture DOM (see
 * src/meet/fixtures/dom.ts) that implements the exact read-only ParentNode
 * subset the selectors use. The WS-client tests use a fake in-process socket.
 *
 * `@loqui/shared` is aliased to its SOURCE (mirroring apps/desktop) so tests
 * type/run against the live contract without depending on a prebuilt dist.
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
    include: ["src/**/*.{test,spec}.ts"],
  },
});
