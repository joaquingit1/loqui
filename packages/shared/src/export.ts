/**
 * PRD-13 shared export & interop contract.
 *
 * Defined ONCE in @loqui/shared so the renderer, preload bridge, and main IPC
 * handlers all type against a single source — mirroring ./postprocess.ts.
 *
 * An EXPORT is a PURE, DETERMINISTIC transform over the canonical, structured
 * transcript (the DIARIZED transcript when available, else the live transcript)
 * + the AI summary. Exports are READ-ONLY over those artifacts — they NEVER
 * mutate the transcript (cross-cutting invariant #1). The transform functions
 * live in apps/desktop/src/main/export/transforms.ts (string/bytes producers);
 * this module defines only the request/result TYPES + zod schemas.
 *
 * Supported formats (a strict superset of a comparable local app's MD/SRT/JSON):
 *   - md       — Markdown with YAML frontmatter (title/date/attendees/tags/
 *                source/kind), Obsidian-vault-compatible.
 *   - obsidian — an Obsidian "note" shape (frontmatter + sections) for the
 *                meeting + summary (a richer MD layout tuned for a vault).
 *   - srt      — SubRip subtitles (timed cues).
 *   - vtt      — WebVTT subtitles (timed cues).
 *   - json     — structured { meeting, segments[], speakers[], summary }.
 *   - pdf      — a rendered PDF document (binary).
 *   - docx     — an OOXML Word document (binary).
 */
import { z } from "zod";

/**
 * The export formats. `md`/`obsidian`/`srt`/`vtt`/`json` are text; `pdf`/`docx`
 * are binary. Additive — new formats append here (defaulted consumers ignore
 * unknown values gracefully).
 */
export const exportFormatSchema = z.enum([
  "md",
  "obsidian",
  "srt",
  "vtt",
  "json",
  "pdf",
  "docx",
]);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** Whether a format's payload is UTF-8 text or raw bytes. */
export const EXPORT_FORMAT_BINARY: Readonly<Record<ExportFormat, boolean>> = {
  md: false,
  obsidian: false,
  srt: false,
  vtt: false,
  json: false,
  pdf: true,
  docx: true,
};

/** The file extension written for each export format. */
export const EXPORT_FORMAT_EXTENSION: Readonly<Record<ExportFormat, string>> = {
  md: "md",
  obsidian: "md",
  srt: "srt",
  vtt: "vtt",
  json: "json",
  pdf: "pdf",
  docx: "docx",
};

/**
 * Params for the `exportMeeting` IPC channel: export ONE meeting in ONE format.
 * `outDir` overrides the configured export directory for this call (the picker
 * passes the chosen dir); when absent the configured `exportDir` setting (or its
 * default) is used.
 */
export const exportMeetingParamsSchema = z.object({
  meetingId: z.string().min(1),
  format: exportFormatSchema,
  /** Optional destination directory; defaults to the configured export dir. */
  outDir: z.string().nullable().default(null).optional(),
});
export type ExportMeetingParams = z.infer<typeof exportMeetingParamsSchema>;

/**
 * Result of an export: the absolute path written, the format, and the byte size.
 * `usedDiarized` reports whether the diarized transcript (vs the live transcript
 * fallback) backed the export, so the UI can note the source.
 */
export const exportResultSchema = z.object({
  meetingId: z.string(),
  format: exportFormatSchema,
  /** Absolute path of the written file. */
  path: z.string(),
  /** Size of the written file in bytes. */
  bytes: z.number().int().nonnegative().default(0),
  /** True when the diarized transcript backed the export (false = live fallback). */
  usedDiarized: z.boolean().default(false),
});
export type ExportResult = z.infer<typeof exportResultSchema>;
