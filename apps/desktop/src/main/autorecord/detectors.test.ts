/**
 * Hermetic tests for the platform detectors (PRD-11).
 *
 * The PURE parsing/matching helpers (tasklist/ps parsing + the allowlist match)
 * are tested directly. The OS-calling `createNativeMeetingProbe` is real-OS +
 * best-effort, so it is only asserted to be TOTAL (never throws, returns a
 * well-formed sample) — real native verification is manual.
 */
import { describe, expect, it } from "vitest";
import {
  createNativeMeetingProbe,
  matchAllowlist,
  nullNativeProbe,
  parsePs,
  parseTasklist,
} from "./detectors.js";

describe("parseTasklist", () => {
  it("extracts image names from CSV rows", () => {
    const stdout = [
      '"zoom.exe","1234","Console","1","120,000 K"',
      '"chrome.exe","5678","Console","1","800,000 K"',
      "",
    ].join("\r\n");
    expect(parseTasklist(stdout)).toEqual(["zoom.exe", "chrome.exe"]);
  });

  it("returns [] for empty/garbage output", () => {
    expect(parseTasklist("")).toEqual([]);
    expect(parseTasklist("not csv at all")).toEqual([]);
  });
});

describe("parsePs", () => {
  it("returns trimmed non-empty lines", () => {
    expect(parsePs("zoom.us\n  Slack \n\nMicrosoft Teams\n")).toEqual([
      "zoom.us",
      "Slack",
      "Microsoft Teams",
    ]);
  });
});

describe("matchAllowlist", () => {
  const allowlist = ["zoom", "teams", "slack", "meet"];

  it("matches case-insensitive substrings", () => {
    expect(matchAllowlist(["Zoom.exe", "chrome.exe"], allowlist)).toEqual(["Zoom.exe"]);
    expect(matchAllowlist(["Microsoft Teams"], allowlist)).toEqual(["Microsoft Teams"]);
  });

  it("does not match unrelated processes", () => {
    expect(matchAllowlist(["explorer.exe", "node.exe"], allowlist)).toEqual([]);
  });

  it("returns [] for an empty allowlist (matches nothing)", () => {
    expect(matchAllowlist(["zoom.exe"], [])).toEqual([]);
  });

  it("ignores blank allowlist entries", () => {
    expect(matchAllowlist(["zoom.exe"], ["", "  ", "zoom"])).toEqual(["zoom.exe"]);
  });

  it("dedupes multiple matches of the same process name", () => {
    expect(matchAllowlist(["zoom.exe", "zoom.exe"], allowlist)).toEqual(["zoom.exe"]);
  });
});

describe("nullNativeProbe", () => {
  it("always reports no native signal", async () => {
    expect(await nullNativeProbe().sample(["zoom"])).toEqual({
      appActive: false,
      micActive: false,
      matched: [],
    });
  });
});

describe("createNativeMeetingProbe — TOTAL (best-effort, manual-verified)", () => {
  it("returns a well-formed sample and keeps the real mic signal inert", async () => {
    const probe = createNativeMeetingProbe(process.platform);
    const sample = await probe.sample(["node", "powershell", "pwsh", "vitest"]);
    expect(sample).toMatchObject({
      appActive: expect.any(Boolean),
      micActive: false,
      matched: expect.any(Array),
    });
  });

  it("returns empty on an unsupported platform", async () => {
    const probe = createNativeMeetingProbe("aix" as NodeJS.Platform);
    expect(await probe.sample(["zoom"])).toEqual({
      appActive: false,
      micActive: false,
      matched: [],
    });
  });
});
