/**
 * PRD-8 — download-to-staging + sha256-verify + extract tests. Uses a STUBBED
 * httpGet feeding a local fixture zip (NO real network). Covers the verify PASS
 * path (asset promoted into place), the ABORT-on-mismatch path (no final file
 * left; the installed app is never touched), offline (the GET throws), and the
 * extract-to-staging round-trip.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { UpdateAsset } from "@loqui/shared";
import {
  Sha256MismatchError,
  downloadAndVerify,
  extractVerified,
  type HttpGet,
} from "./download.js";
import { buildZip } from "./zipfixture.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loqui-dl-"));
}
function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

const FIXTURE = buildZip([
  { name: "Loqui.app/Contents/Info.plist", data: "<plist/>", method: "store" },
  { name: "Loqui.app/Contents/MacOS/loqui", data: "BIN".repeat(50), method: "deflate" },
]);

function assetFor(buf: Buffer, sha256 = sha(buf)): UpdateAsset {
  return {
    url: "https://example.com/releases/Loqui-1.2.3-arm64-mac.zip",
    sha256,
    size: buf.length,
  };
}

describe("downloadAndVerify", () => {
  it("downloads to staging, verifies sha256, and promotes the .part to the final name", async () => {
    const staging = tmp();
    const httpGet: HttpGet = vi.fn(async (_url, onProgress) => {
      onProgress?.(FIXTURE.length, FIXTURE.length);
      return FIXTURE;
    });
    const out = await downloadAndVerify(assetFor(FIXTURE), staging, { httpGet });
    expect(out).toBe(join(staging, "Loqui-1.2.3-arm64-mac.zip"));
    expect(existsSync(out)).toBe(true);
    // No leftover .part file.
    expect(readdirSync(staging).some((f) => f.endsWith(".part"))).toBe(false);
    expect(readFileSync(out).equals(FIXTURE)).toBe(true);
    expect(httpGet).toHaveBeenCalledOnce();
  });

  it("ABORTS on a sha256 mismatch and leaves NO final file (installed app intact)", async () => {
    const staging = tmp();
    const httpGet: HttpGet = vi.fn(async () => FIXTURE);
    const badAsset = assetFor(FIXTURE, "0".repeat(64)); // wrong expected hash
    await expect(downloadAndVerify(badAsset, staging, { httpGet })).rejects.toBeInstanceOf(
      Sha256MismatchError,
    );
    // Neither the final file NOR the .part survives.
    expect(existsSync(join(staging, "Loqui-1.2.3-arm64-mac.zip"))).toBe(false);
    expect(readdirSync(staging).filter((f) => f.includes("Loqui"))).toHaveLength(0);
  });

  it("propagates an offline / network error without leaving a partial file", async () => {
    const staging = tmp();
    const httpGet: HttpGet = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND example.com");
    });
    await expect(downloadAndVerify(assetFor(FIXTURE), staging, { httpGet })).rejects.toThrow(
      /ENOTFOUND/,
    );
    expect(existsSync(join(staging, "Loqui-1.2.3-arm64-mac.zip"))).toBe(false);
  });

  it("cleans a stale .part from a prior interrupted run before downloading", async () => {
    const staging = tmp();
    // First run: a partial download (a truncated body) that mismatches and aborts.
    const partial = FIXTURE.subarray(0, 10);
    const fail: HttpGet = vi.fn(async () => partial);
    await expect(
      downloadAndVerify(assetFor(FIXTURE), staging, { httpGet: fail }),
    ).rejects.toBeInstanceOf(Sha256MismatchError);
    // Second run with the correct body succeeds cleanly.
    const ok: HttpGet = vi.fn(async () => FIXTURE);
    const out = await downloadAndVerify(assetFor(FIXTURE), staging, { httpGet: ok });
    expect(readFileSync(out).equals(FIXTURE)).toBe(true);
  });
});

describe("extractVerified", () => {
  it("extracts a verified zip into the staging extract dir", async () => {
    const staging = tmp();
    const httpGet: HttpGet = vi.fn(async () => FIXTURE);
    const zipPath = await downloadAndVerify(assetFor(FIXTURE), staging, { httpGet });
    const root = await extractVerified(zipPath, join(staging, "extracted"));
    expect(readFileSync(join(root, "Loqui.app/Contents/Info.plist"), "utf8")).toBe("<plist/>");
  });
});
