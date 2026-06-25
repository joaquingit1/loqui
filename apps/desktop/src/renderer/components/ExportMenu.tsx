/**
 * ExportMenu — the per-meeting Export action (PRD-13).
 *
 * Offers the meeting's export formats (Markdown, Obsidian note, SRT, VTT, JSON,
 * PDF, DOCX); selecting one calls `window.loqui.export.exportMeeting` (READ-ONLY
 * over the transcript — main builds the file from the diarized/live transcript +
 * summary and writes it under the configured export folder) and shows the
 * written path. Talks ONLY to the typed `window.loqui.export` bridge (injectable
 * for tests).
 */
import { useCallback, useState, type JSX } from "react";
import type { ExportFormat } from "@loqui/shared";
import type { LoquiExportApi } from "../../preload/index.js";

export interface ExportMenuProps {
  meetingId: string;
  /** Export bridge. Injectable for tests; defaults to window.loqui.export. */
  api?: Pick<LoquiExportApi, "exportMeeting">;
}

const FORMATS: Array<{ format: ExportFormat; label: string }> = [
  { format: "md", label: "Markdown" },
  { format: "obsidian", label: "Obsidian note" },
  { format: "srt", label: "SRT" },
  { format: "vtt", label: "VTT" },
  { format: "json", label: "JSON" },
  { format: "pdf", label: "PDF" },
  { format: "docx", label: "DOCX" },
];

export function ExportMenu({ meetingId, api }: ExportMenuProps): JSX.Element {
  const exp = api ?? (typeof window !== "undefined" ? window.loqui?.export : undefined);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onExport = useCallback(
    async (format: ExportFormat) => {
      if (!exp?.exportMeeting) return;
      setBusy(format);
      setError(null);
      setResult(null);
      try {
        const res = await exp.exportMeeting({ meetingId, format });
        setResult(`Exported ${format.toUpperCase()} → ${res.path}`);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [exp, meetingId],
  );

  return (
    <div className="export-menu" data-testid="export-menu">
      <span className="export-menu__label">Export:</span>
      {FORMATS.map(({ format, label }) => (
        <button
          key={format}
          type="button"
          className="btn export-menu__btn"
          data-testid={`export-${format}`}
          disabled={busy !== null || !exp?.exportMeeting}
          onClick={() => void onExport(format)}
        >
          {busy === format ? "Exporting…" : label}
        </button>
      ))}
      {result && (
        <p className="export-menu__result" data-testid="export-result">
          {result}
        </p>
      )}
      {error && (
        <p className="export-menu__error" data-testid="export-error" role="alert">
          Export failed: {error}
        </p>
      )}
    </div>
  );
}
