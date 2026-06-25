/**
 * Export service (PRD-13, main side).
 *
 * Import as: `import { ExportService } from "../export/service.js"`
 *
 * The I/O orchestration around the PURE transforms: it READS a meeting's
 * canonical artifacts via the store (the diarized transcript when available,
 * else the live transcript markdown; plus the AI summary + meta), builds the
 * normalized {@link ExportModel}, renders the requested format, and writes the
 * bytes to the configured export directory.
 *
 * CROSS-CUTTING INVARIANT #1: exports are READ-ONLY over the canonical
 * transcript. This service NEVER writes a transcript/meta file — it only reads
 * via the store and writes a NEW file under the export dir. transcript.live.md
 * stays byte-identical.
 *
 * Determinism: the rendered bytes depend only on the model (no Date.now / random
 * in the transforms). The output FILENAME embeds a timestamp so repeated exports
 * don't clobber, but the rendered CONTENT for a given meeting+format is stable.
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXPORT_FORMAT_BINARY,
  EXPORT_FORMAT_EXTENSION,
  exportResultSchema,
  type ExportFormat,
  type ExportMeetingParams,
  type ExportResult,
  type DiarizedTranscript,
  type Meeting,
  type Summary,
} from "@loqui/shared";
import { buildExportModel, type ExportModel } from "./model.js";
import { toJson, toMarkdown, toObsidian, toSrt, toVtt } from "./transforms.js";
import { toDocx, toPdf } from "./binary.js";

/** The narrow store surface the export service needs (read-only). */
export type ExportStore = Pick<
  {
    getMeeting(id: string): Meeting | null;
    getDiarizedTranscript(id: string): DiarizedTranscript | null;
    getTranscript(id: string, variant?: "live" | "structured"): string;
    getSummary(id: string): Summary | null;
  },
  "getMeeting" | "getDiarizedTranscript" | "getTranscript" | "getSummary"
>;

export interface ExportServiceDeps {
  store: ExportStore;
  /** Resolve the configured export directory (defaulted by the settings store). */
  getExportDir(): string;
}

export class ExportService {
  readonly #store: ExportStore;
  readonly #getExportDir: () => string;

  constructor(deps: ExportServiceDeps) {
    this.#store = deps.store;
    this.#getExportDir = deps.getExportDir;
  }

  /**
   * Build the normalized export model for a meeting (diarized when available,
   * else live transcript). Throws if the meeting does not exist. PURE except for
   * the store reads — exposed for tests + the IPC handler.
   */
  buildModel(meetingId: string): ExportModel {
    const meeting = this.#store.getMeeting(meetingId);
    if (!meeting) throw new Error(`export: unknown meeting ${meetingId}`);
    const diarized = this.#store.getDiarizedTranscript(meetingId);
    const liveTranscript = this.#store.getTranscript(meetingId, "live");
    const summary = this.#store.getSummary(meetingId);
    return buildExportModel({ meeting, diarized, liveTranscript, summary });
  }

  /** Render one format from a model to bytes/string. Async (PDF/DOCX await). */
  async render(model: ExportModel, format: ExportFormat): Promise<string | Buffer> {
    switch (format) {
      case "md":
        return toMarkdown(model);
      case "obsidian":
        return toObsidian(model);
      case "srt":
        return toSrt(model);
      case "vtt":
        return toVtt(model);
      case "json":
        return toJson(model);
      case "pdf":
        return toPdf(model);
      case "docx":
        return toDocx(model);
      default: {
        // Exhaustiveness guard: a new format must add a case above.
        const never: never = format;
        throw new Error(`export: unsupported format ${String(never)}`);
      }
    }
  }

  /**
   * Export ONE meeting in ONE format. Reads the artifacts, renders, and writes
   * the bytes under the (optionally overridden) export dir. Returns the written
   * path + size + which transcript backed it. NEVER mutates the transcript.
   */
  async exportMeeting(params: ExportMeetingParams): Promise<ExportResult> {
    const { meetingId, format } = params;
    const model = this.buildModel(meetingId);
    const payload = await this.render(model, format);

    const dir = params.outDir && params.outDir.trim() !== "" ? params.outDir : this.#getExportDir();
    mkdirSync(dir, { recursive: true });

    const ext = EXPORT_FORMAT_EXTENSION[format];
    const fileName = `${exportFileStem(model.meeting)}.${format === "obsidian" ? "obsidian." + ext : ext}`;
    const outPath = join(dir, fileName);

    if (EXPORT_FORMAT_BINARY[format]) {
      writeFileSync(outPath, payload as Buffer);
    } else {
      writeFileSync(outPath, payload as string, "utf8");
    }

    const bytes = statSync(outPath).size;
    return exportResultSchema.parse({
      meetingId,
      format,
      path: outPath,
      bytes,
      usedDiarized: model.usedDiarized,
    });
  }
}

/**
 * A filesystem-safe filename stem for a meeting export: a slug of the title (or
 * "meeting") + a short id suffix so distinct meetings never collide. No
 * timestamp (re-exporting the same meeting+format overwrites, which is the least
 * surprising behavior); the id suffix disambiguates same-titled meetings.
 */
function exportFileStem(meeting: Meeting): string {
  const slug = (meeting.title || "meeting")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const idSuffix = meeting.id.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return `${slug || "meeting"}-${idSuffix}`;
}
