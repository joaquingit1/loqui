/**
 * ExportMenu — the per-meeting Export action (PRD-13).
 *
 * A single `Export ▾` button that opens a small dropdown listing the meeting's
 * export formats (Markdown, Obsidian note, SRT, VTT, JSON, PDF, DOCX) —
 * consolidated into one menu rather than a row of inline pills (DESIGN-SYSTEM
 * §12.3/§12.5). Selecting one calls `window.loqui.export.exportMeeting`
 * (READ-ONLY over the transcript — main builds the file from the diarized/live
 * transcript + summary and writes it under the configured export folder) and
 * shows the written path. Talks ONLY to the typed `window.loqui.export` bridge
 * (injectable for tests).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { ExportFormat } from "@loqui/shared";
import type { LoquiExportApi } from "../../preload/index.js";
import { Icon } from "./Icon.js";

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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onExport = useCallback(
    async (format: ExportFormat) => {
      if (!exp?.exportMeeting) return;
      setBusy(format);
      setError(null);
      setResult(null);
      try {
        const res = await exp.exportMeeting({ meetingId, format });
        setResult(`Exported ${format.toUpperCase()} to ${res.path}`);
        setOpen(false);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [exp, meetingId],
  );

  const disabled = !exp?.exportMeeting;

  return (
    <div className="export-menu" data-testid="export-menu" ref={rootRef}>
      <button
        type="button"
        className="export-menu__trigger"
        data-testid="export-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy !== null}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="download" size={16} aria-hidden="true" />
        <span>{busy ? "Exporting…" : "Export"}</span>
        <Icon name="chevron-down" size={14} aria-hidden="true" />
      </button>

      {open && (
        <ul className="export-menu__list" role="menu" data-testid="export-list">
          {FORMATS.map(({ format, label }) => (
            <li key={format} role="none">
              <button
                type="button"
                role="menuitem"
                className="export-menu__item"
                data-testid={`export-${format}`}
                disabled={busy !== null || disabled}
                onClick={() => void onExport(format)}
              >
                {busy === format ? "Exporting…" : label}
              </button>
            </li>
          ))}
        </ul>
      )}

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
