/**
 * Export & interop module barrel (PRD-13).
 *
 * Re-exports the pure transforms (text + binary), the normalized model builder,
 * and the I/O service so the IPC layer imports a single entry point.
 */
export { ExportService, type ExportServiceDeps, type ExportStore } from "./service.js";
export {
  buildExportModel,
  parseLiveTranscript,
  type ExportModel,
  type ExportSegment,
} from "./model.js";
export {
  toMarkdown,
  toObsidian,
  toSrt,
  toVtt,
  toJson,
  formatSrtTimestamp,
  formatVttTimestamp,
  type ExportJsonDocument,
} from "./transforms.js";
export { toPdf, toDocx } from "./binary.js";
