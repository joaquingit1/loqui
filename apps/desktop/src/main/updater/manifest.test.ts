/**
 * PRD-8 — manifest parse + decide tests. Covers a valid manifest round-trip
 * through the shared schema, rejecting a malformed manifest, the
 * newer/equal/older decision, and the per-platform asset selection (including a
 * newer version with NO asset for this platform => no update).
 */
import { describe, expect, it } from "vitest";
import { decideUpdate, parseManifest } from "./manifest.js";

const VALID = {
  version: "1.2.3",
  notes: "Bug fixes",
  platforms: {
    "darwin-arm64": {
      url: "https://example.com/Loqui-1.2.3-arm64-mac.zip",
      sha256: "a".repeat(64),
      size: 100,
    },
    "win32-x64": {
      url: "https://example.com/Loqui-1.2.3-win.zip",
      sha256: "b".repeat(64),
      size: 200,
    },
  },
};

describe("parseManifest", () => {
  it("validates + round-trips a well-formed manifest (object or JSON string)", () => {
    const fromObj = parseManifest(VALID);
    const fromStr = parseManifest(JSON.stringify(VALID));
    expect(fromObj).toEqual(fromStr);
    expect(fromObj.version).toBe("1.2.3");
    expect(fromObj.platforms["win32-x64"]?.sha256).toBe("b".repeat(64));
  });

  it("rejects a manifest with a malformed sha256 (integrity guard)", () => {
    const bad = {
      ...VALID,
      platforms: { "win32-x64": { url: "https://x/y.zip", sha256: "xyz", size: 1 } },
    };
    expect(() => parseManifest(bad)).toThrow();
  });

  it("rejects a manifest missing a version", () => {
    expect(() => parseManifest({ platforms: {} })).toThrow();
  });
});

describe("decideUpdate", () => {
  it("flags an update when the manifest is newer AND has this platform's asset", () => {
    const d = decideUpdate(parseManifest(VALID), "1.2.2", "win32", "x64");
    expect(d.isUpdate).toBe(true);
    expect(d.version).toBe("1.2.3");
    expect(d.asset?.url).toContain("win.zip");
  });

  it("no update when the running version is equal or newer", () => {
    expect(decideUpdate(parseManifest(VALID), "1.2.3", "win32", "x64").isUpdate).toBe(false);
    expect(decideUpdate(parseManifest(VALID), "1.3.0", "win32", "x64").isUpdate).toBe(false);
  });

  it("no update when newer but there is NO asset for this platform/arch", () => {
    // darwin-x64 is absent from VALID.platforms.
    const d = decideUpdate(parseManifest(VALID), "1.0.0", "darwin", "x64");
    expect(d.isUpdate).toBe(false);
    expect(d.asset).toBeNull();
  });

  it("selects the correct per-platform asset", () => {
    const mac = decideUpdate(parseManifest(VALID), "1.0.0", "darwin", "arm64");
    expect(mac.isUpdate).toBe(true);
    expect(mac.asset?.url).toContain("arm64-mac.zip");
  });
});
