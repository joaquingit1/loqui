/**
 * PRD-8 test helper — build a minimal but spec-correct ZIP buffer in memory so
 * the download/extract tests stay hermetic (no real GitHub artifact, no temp
 * external zip tool). Supports store (method 0) and deflate (method 8) entries
 * and optional Unix mode bits (to assert the executable bit survives extraction).
 *
 * Lives in src/ (not a *.test.ts) so it is importable by the tests; it is not a
 * test file itself.
 */
import { crc32 } from "node:zlib";
import { deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
  /** Entry path (use a trailing "/" for a directory entry). */
  name: string;
  /** File contents (ignored for directory entries). */
  data?: Buffer | string;
  /** Compression: "store" (0) or "deflate" (8). Default "deflate". */
  method?: "store" | "deflate";
  /** Optional Unix mode (e.g. 0o755) stored in external attrs (high 16 bits). */
  unixMode?: number;
}

function dosTime(): { time: number; date: number } {
  // Fixed timestamp (2024-01-01 00:00:00) — deterministic fixtures.
  return { time: 0, date: ((2024 - 1980) << 9) | (1 << 5) | 1 };
}

/** Build a ZIP buffer from the given entries. */
export function buildZip(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosTime();

  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const raw = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data ?? "", "utf8");
    const methodName = entry.method ?? "deflate";
    const method = isDir || methodName === "store" ? 0 : 8;
    const compressed = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;
    const nameBuf = Buffer.from(entry.name, "utf8");

    // Local file header.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBuf, compressed);

    // Central directory header.
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    const externalAttrs = entry.unixMode ? (entry.unixMode << 16) >>> 0 : 0;
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}
