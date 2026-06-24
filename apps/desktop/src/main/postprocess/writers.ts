/**
 * Atomic writers for the DERIVED diarized transcript files (PRD-5), used by the
 * main-driven speaker-rename rewrite.
 *
 * SCOPE / INVARIANT (cross-cutting, re-asserted): this module writes ONLY the
 * derived diarized transcript (`transcript.diarized.json` + `.md`). It has NO
 * code path that writes transcript.live.md / transcript.jsonl / meta.json /
 * summary.json — those are owned elsewhere (main's TranscriptWriter/store; the
 * sidecar's summary writer). A rename is a deterministic re-labeling of the
 * diarized file, NOT an AI write and NOT a live-transcript write.
 *
 * The sidecar (the postprocess Build unit) is the FIRST producer of these files.
 * On a rename, main re-reads the diarized JSON via the store reader, applies the
 * rename in memory, and rewrites BOTH files here so the `.md` re-renders with the
 * friendly name. Writes are atomic (temp file + rename) so a reader never sees a
 * partial file and a re-run cleanly REPLACES prior output (idempotent).
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { diarizedTranscriptSchema, type DiarizedTranscript } from "@loqui/shared";
import {
  meetingDiarizedTranscriptJsonPath,
  meetingDiarizedTranscriptMdPath,
} from "../store/paths.js";
import { renderDiarizedMd } from "./render.js";

/** Write `text` to `path` atomically (temp file in the same dir + rename). */
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Persist a {@link DiarizedTranscript} as `transcript.diarized.json` (validated
 * + pretty-printed, trailing newline) + the rendered `transcript.diarized.md`
 * ({@link renderDiarizedMd}). Atomic; idempotently replaces prior output. The
 * ONLY files this writes are the two diarized derived files for `diarized.meetingId`.
 */
export function writeDiarizedTranscript(diarized: DiarizedTranscript): void {
  const clean = diarizedTranscriptSchema.parse(diarized);
  atomicWrite(
    meetingDiarizedTranscriptJsonPath(clean.meetingId),
    `${JSON.stringify(clean, null, 2)}\n`,
  );
  atomicWrite(meetingDiarizedTranscriptMdPath(clean.meetingId), renderDiarizedMd(clean));
}
