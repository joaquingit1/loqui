/**
 * PRD-8 — zip extraction tests. Builds an in-memory fixture zip (store +
 * deflate + a nested dir + a Unix-mode entry) and asserts the extractor writes
 * the tree correctly, preserves the executable bit on POSIX, and refuses
 * zip-slip entries.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZip } from "./zip.js";
import { buildZip } from "./zipfixture.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "loqui-zip-"));
}

describe("extractZip", () => {
  it("extracts store + deflate entries and a nested directory tree", async () => {
    const zip = buildZip([
      { name: "Loqui.app/", data: "" },
      { name: "Loqui.app/Contents/", data: "" },
      { name: "Loqui.app/Contents/Info.plist", data: "<plist/>", method: "store" },
      {
        name: "Loqui.app/Contents/MacOS/loqui",
        data: "BINARY-DATA-".repeat(100),
        method: "deflate",
      },
    ]);
    const dest = tmp();
    const written = await extractZip(zip, dest);
    expect(written).toBe(2); // two file entries (dir entries don't count)
    expect(readFileSync(join(dest, "Loqui.app/Contents/Info.plist"), "utf8")).toBe("<plist/>");
    expect(readFileSync(join(dest, "Loqui.app/Contents/MacOS/loqui"), "utf8")).toBe(
      "BINARY-DATA-".repeat(100),
    );
  });

  it("preserves the executable bit on POSIX hosts", async () => {
    const zip = buildZip([
      { name: "run.sh", data: "#!/bin/sh\necho hi\n", unixMode: 0o755 },
    ]);
    const dest = tmp();
    await extractZip(zip, dest);
    if (process.platform !== "win32") {
      const mode = statSync(join(dest, "run.sh")).mode & 0o777;
      expect(mode & 0o100).toBe(0o100); // owner-executable bit set
    } else {
      // On Windows mode bits are not POSIX; just assert the file exists.
      expect(readFileSync(join(dest, "run.sh"), "utf8")).toContain("echo hi");
    }
  });

  it("refuses a zip-slip entry that escapes the destination", async () => {
    const zip = buildZip([{ name: "../evil.txt", data: "pwned", method: "store" }]);
    const dest = tmp();
    await expect(extractZip(zip, dest)).rejects.toThrow(/zip-slip/);
  });

  it("throws on a non-zip buffer", async () => {
    await expect(extractZip(Buffer.from("not a zip"), tmp())).rejects.toThrow(/zip/i);
  });
});
