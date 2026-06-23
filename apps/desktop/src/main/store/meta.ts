/**
 * Atomic read/write of a meeting's `meta.json`.
 *
 * Writes go through a temp file in the SAME directory, are fsync'd, then
 * atomically renamed over the target. A rename within a directory is atomic on
 * POSIX and on Windows (ReplaceFile semantics via fs.renameSync's MoveFileEx),
 * so a reader never observes a partially written meta.json and a crash mid-write
 * leaves at most an orphan `*.tmp-*` file (which readers ignore).
 *
 * All values are validated against the shared zod `meetingSchema` on the way in
 * AND on the way out, so partial / older-format files parse forward via the
 * schema defaults and malformed files fail loudly.
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { meetingSchema, type Meeting } from "@loqui/shared";
import { meetingMetaPath } from "./paths.js";

/** Suffix used for in-progress temp files so readers/listers can skip them. */
export const META_TMP_SUFFIX = ".tmp-" as const;

/**
 * Serialize + validate a Meeting and write it atomically to
 * `<meetingDir>/meta.json`. Creates the meeting directory if absent.
 */
export function writeMeta(meeting: Meeting): void {
  // Validate before persisting so we never write a meta.json that would later
  // fail to read back.
  const valid = meetingSchema.parse(meeting);
  const target = meetingMetaPath(valid.id);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  const json = `${JSON.stringify(valid, null, 2)}\n`;
  // Unique temp name in the same dir; include pid + counter + random to avoid
  // collisions between concurrent writers to different meetings (or retries).
  const tmp = `${target}${META_TMP_SUFFIX}${process.pid}-${(tmpCounter =
    (tmpCounter + 1) >>> 0)}-${Math.random().toString(36).slice(2)}`;

  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, json);
    // Flush file contents to disk before the rename so the rename can't expose
    // an empty/partial file after a crash.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

let tmpCounter = 0;

/**
 * Read + validate `<meetingDir>/meta.json`. Returns null if the file does not
 * exist. Throws if the file exists but is corrupt / fails schema validation.
 */
export function readMeta(id: string): Meeting | null {
  const target = meetingMetaPath(id);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return meetingSchema.parse(parsed);
}
