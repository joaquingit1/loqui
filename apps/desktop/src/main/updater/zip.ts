/**
 * PRD-8 — a minimal, dependency-free ZIP extractor built on Node's `zlib`.
 *
 * The update-channel artifacts are plain zips (a zipped `.app` on macOS, a
 * portable zip on Windows). Rather than add a runtime zip dependency, we parse
 * the ZIP central directory and inflate each entry with the built-in
 * `zlib.inflateRawSync` (method 8 / deflate) or copy it verbatim (method 0 /
 * store). This keeps the trust surface tiny (we control the extraction) and the
 * code fully unit-testable with a fixture zip.
 *
 * Preserves the directory tree and, on POSIX hosts, the Unix permission bits
 * stored in the central-directory "external file attributes" — so the `.app`'s
 * executable bit survives extraction and Gatekeeper can relaunch the swapped app
 * after the helper's ad-hoc re-sign. Guards against zip-slip (entries that escape
 * the destination via `..`).
 */
import { inflateRawSync } from "node:zlib";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttrs: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Find the End-Of-Central-Directory record (search backward; it has a var-length comment). */
function findEocd(buf: Buffer): number {
  // Minimum EOCD is 22 bytes; the comment can be up to 65535 bytes.
  const minPos = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip file (no EOCD record found)");
}

/** Parse the central directory into entry records. */
function parseCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: CentralEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) {
      throw new Error(`corrupt zip: bad central-directory signature at entry ${i}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttrs,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read one entry's raw compressed bytes by following its local header. */
function readEntryData(buf: Buffer, entry: CentralEntry): Buffer {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== LOC_SIG) {
    throw new Error(`corrupt zip: bad local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed); // store
  if (entry.method === 8) return inflateRawSync(compressed); // deflate
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** Resolve + guard an entry path against zip-slip; returns the safe absolute path. */
function safeJoin(destDir: string, name: string): string {
  const target = normalize(join(destDir, name));
  const root = normalize(destDir);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`zip entry escapes destination (zip-slip): ${name}`);
  }
  return target;
}

/**
 * Extract every entry of a zip (provided as a Buffer) into `destDir`. Directory
 * entries create dirs; file entries are inflated/copied and written; on POSIX,
 * the Unix mode bits from the external attributes are applied (so the `.app`
 * binary stays executable). Returns the number of files written.
 */
export async function extractZip(zipBuf: Buffer, destDir: string): Promise<number> {
  const entries = parseCentralDirectory(zipBuf);
  let written = 0;
  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const outPath = safeJoin(destDir, entry.name);
    if (isDir) {
      mkdirSync(outPath, { recursive: true });
      continue;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    const data = readEntryData(zipBuf, entry);
    writeFileSync(outPath, data);
    written += 1;
    // Apply the Unix permission bits (high 16 of external attrs) on POSIX hosts.
    if (process.platform !== "win32") {
      const unixMode = (entry.externalAttrs >>> 16) & 0xffff;
      if (unixMode !== 0) {
        try {
          chmodSync(outPath, unixMode & 0o7777);
        } catch {
          /* best-effort: permission application must not abort extraction */
        }
      }
    }
  }
  return written;
}
