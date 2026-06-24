/**
 * PRD-6 — runtime contract constants for the INJECTED content script.
 *
 * WHY THIS FILE EXISTS (and is not just `import { ... } from "@loqui/shared"`):
 * the shared package's only entry point is its barrel (`index.ts`), which
 * eagerly evaluates zod schemas at import time. esbuild therefore cannot
 * tree-shake zod out, and importing the WS endpoint *constants* from the barrel
 * would bundle ~150kb of zod into a script we inject into EVERY Meet page.
 *
 * So the four endpoint constants are mirrored here as plain strings/numbers, and
 * `contract.test.ts` asserts byte-for-byte that they equal the @loqui/shared
 * source of truth — the test is the guard against drift. We deliberately do NOT
 * modify @loqui/shared (a Foundation-owned manifest) to add a zod-free subpath.
 *
 * The wire SHAPES (ExtensionMessage / SpeakerActivityEvent) are still imported as
 * `import type` from @loqui/shared everywhere — types are erased at build time and
 * cost nothing at runtime, so there is exactly one structural source of truth.
 */

/** Loopback host the extension dials. Mirrors @loqui/shared SPEAKERNAMES_WS_HOST. */
export const SPEAKERNAMES_WS_HOST = "127.0.0.1" as const;

/** Default loopback port. Mirrors @loqui/shared SPEAKERNAMES_WS_DEFAULT_PORT. */
export const SPEAKERNAMES_WS_DEFAULT_PORT = 7345 as const;

/** WS path. Mirrors @loqui/shared SPEAKERNAMES_WS_PATH. */
export const SPEAKERNAMES_WS_PATH = "/loqui-meet" as const;

/** Meet origin the content script runs on. Mirrors @loqui/shared MEET_ORIGIN. */
export const MEET_ORIGIN = "https://meet.google.com" as const;
