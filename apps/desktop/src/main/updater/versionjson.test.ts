/**
 * PRD-8 — `version.json` generator tests. Covers pure composition
 * (buildManifest), the I/O generator with an injected hasher/sizer (hermetic),
 * and a JSON-schema-validated round-trip (the generated manifest parses back
 * through the shared schema and the updater's own parser).
 */
import { describe, expect, it, vi } from "vitest";
import { buildManifest, generateVersionJson } from "./versionjson.js";
import { parseManifest } from "./manifest.js";

describe("buildManifest", () => {
  it("composes a schema-valid manifest from hashed assets", () => {
    const m = buildManifest({
      version: "2.0.0",
      notes: "Big release",
      assets: [
        {
          platform: "win32-x64",
          asset: { url: "https://x/Loqui-2.0.0-win.zip", sha256: "c".repeat(64), size: 10 },
        },
        {
          platform: "darwin-arm64",
          asset: { url: "https://x/Loqui-2.0.0-arm64-mac.zip", sha256: "d".repeat(64), size: 20 },
        },
      ],
    });
    expect(m.version).toBe("2.0.0");
    expect(Object.keys(m.platforms).sort()).toEqual(["darwin-arm64", "win32-x64"]);
  });

  it("throws on a bad asset (sha256 not 64 hex) — the integrity guard", () => {
    expect(() =>
      buildManifest({
        version: "1.0.0",
        assets: [{ platform: "win32-x64", asset: { url: "https://x/y.zip", sha256: "nope", size: 1 } }],
      }),
    ).toThrow();
  });
});

describe("generateVersionJson", () => {
  it("hashes each artifact via the injected hasher and round-trips through the schema", async () => {
    const hash = vi.fn(async (file: string) =>
      file.includes("win") ? "e".repeat(64) : "f".repeat(64),
    );
    const size = vi.fn((file: string) => (file.includes("win") ? 111 : 222));
    const manifest = await generateVersionJson(
      {
        version: "3.1.4",
        notes: "pi",
        pubDate: "2026-06-25T00:00:00.000Z",
        artifacts: [
          { platform: "win32-x64", file: "/out/Loqui-win.zip", url: "https://x/Loqui-win.zip" },
          {
            platform: "darwin-arm64",
            file: "/out/Loqui-mac.zip",
            url: "https://x/Loqui-mac.zip",
          },
        ],
      },
      { hash, size },
    );

    expect(hash).toHaveBeenCalledTimes(2);
    expect(manifest.platforms["win32-x64"]).toEqual({
      url: "https://x/Loqui-win.zip",
      sha256: "e".repeat(64),
      size: 111,
    });
    expect(manifest.pubDate).toBe("2026-06-25T00:00:00.000Z");

    // JSON-schema-validated manifest round-trip: serialize -> parse back.
    const reparsed = parseManifest(JSON.stringify(manifest));
    expect(reparsed).toEqual(manifest);
  });
});
