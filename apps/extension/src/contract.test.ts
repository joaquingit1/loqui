/**
 * PRD-6 — contract drift guard.
 *
 * The injected content script mirrors the WS endpoint constants locally (see
 * contract.ts) to keep zod out of the bundle. This test is the SINGLE SOURCE OF
 * TRUTH enforcement: it imports the real values from @loqui/shared (test-only —
 * zod in a test is fine) and asserts the local mirror matches exactly. If a
 * Foundation change ever moves the port/host/path, this test fails loudly.
 */
import { describe, expect, it } from "vitest";
import * as shared from "@loqui/shared";
import {
  MEET_ORIGIN,
  SPEAKERNAMES_WS_DEFAULT_PORT,
  SPEAKERNAMES_WS_HOST,
  SPEAKERNAMES_WS_PATH,
} from "./contract.js";

describe("local contract mirror matches @loqui/shared", () => {
  it("host", () => {
    expect(SPEAKERNAMES_WS_HOST).toBe(shared.SPEAKERNAMES_WS_HOST);
  });
  it("default port", () => {
    expect(SPEAKERNAMES_WS_DEFAULT_PORT).toBe(shared.SPEAKERNAMES_WS_DEFAULT_PORT);
  });
  it("path", () => {
    expect(SPEAKERNAMES_WS_PATH).toBe(shared.SPEAKERNAMES_WS_PATH);
  });
  it("Meet origin", () => {
    expect(MEET_ORIGIN).toBe(shared.MEET_ORIGIN);
  });
  it("host is loopback only (never a public bind)", () => {
    expect(SPEAKERNAMES_WS_HOST).toBe("127.0.0.1");
  });
});
