/**
 * MeetingDoc — the ONE finished-meeting surface (summary-centric redesign).
 *
 * Renders a meeting as a flat DOCUMENT (no card-over-card): a serif title, a
 * muted meta line, the AI SUMMARY as the centerpiece (streamed live while it
 * generates, then the parsed structured sections), a collapsible "View
 * transcript", and a docked bottom chat composer ("Continue chat"). The SAME
 * component renders both a meeting opened from the library AND a just-finished
 * meeting (the live page swaps to this on `done`), so there is no library
 * round-trip and the experience is identical.
 *
 * READ-ONLY over the transcript (the AI never edits it): it reads
 * transcript/summary, renames via the typed bridge, and asks main to
 * regenerate — there is no transcript write path here.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Meeting } from "@loqui/shared";
import type {
  LoquiChatApi,
  LoquiExportApi,
  LoquiLibraryApi,
} from "../../preload/index.js";
import { ExportMenu } from "./ExportMenu.js";
import { Icon } from "./Icon.js";
import { displayTitle, formatDuration, platformLabel } from "../library/grouping.js";
import { SummaryView } from "./SummaryView.js";
import { ChatPanel } from "./ChatPanel.js";
import { ProcessingStatus } from "./ProcessingStatus.js";
import { useJobProgress, useSummaryStream, allJobsTerminal } from "../summary/index.js";
import "../library/library.css";

export interface MeetingDocProps {
  /** The meeting to display (live-finished via the controller, or loaded by id). */
  meeting: Meeting;
  /** Library bridge (subset). Injectable for tests; defaults to window.loqui.library. */
  api?: Pick<LoquiLibraryApi, "getTranscript" | "renameMeeting">;
  /** Export bridge (PRD-13). Injectable for tests; defaults to window.loqui.export. */
  exportApi?: Pick<LoquiExportApi, "exportMeeting">;
  /** Chat bridge (PRD-4). Injectable for tests; defaults to window.loqui.chat. */
  chatApi?: LoquiChatApi;
  /** Optional back affordance (present when opened from the library). */
  onBack?: () => void;
  /** Fired with the updated Meeting after a successful rename. */
  onRenamed?: (meeting: Meeting) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "error"; message: string };

export function MeetingDoc({
  meeting,
  api,
  exportApi,
  chatApi,
  onBack,
  onRenamed,
}: MeetingDocProps): JSX.Element {
  const library = (api ?? window.loqui?.library) as MeetingDocProps["api"] | undefined;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  // Post-processing progress (diarization + summary + re-transcription). A job
  // completing bumps the matching reload key so the derived files refetch; a
  // summary "running" resets the streamed-summary buffer (fresh generation).
  const [summaryReload, setSummaryReload] = useState(0);
  const [transcriptReload, setTranscriptReload] = useState(0);
  const [summaryRunKey, setSummaryRunKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const { jobs } = useJobProgress({
    onEvent: (event) => {
      if (event.kind === "summary") {
        if (event.state === "running") setSummaryRunKey((n) => n + 1);
        if (event.state === "done" || event.state === "error") {
          setSummaryReload((n) => n + 1);
          setRegenerating(false);
        }
      }
      if (event.kind === "transcription" && event.state === "done") {
        setTranscriptReload((n) => n + 1);
      }
    },
  });
  // The live summary text, streamed token-by-token while the summary generates.
  const { text: streamingSummary } = useSummaryStream(meeting.id, { resetKey: summaryRunKey });

  const processing = meeting.status === "processing";
  const postReady = meeting.status === "done" || meeting.status === "processing";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load the transcript whenever the target meeting changes (or hi-fi re-transcribe lands).
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    if (!library?.getTranscript) {
      setLoad({ kind: "loaded", text: "" });
      return;
    }
    library
      .getTranscript({ id: meeting.id, variant: "live" })
      .then((text) => {
        if (!cancelled) setLoad({ kind: "loaded", text });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [library, meeting.id, transcriptReload]);

  useEffect(() => {
    if (!editing) setDraft(meeting.title);
  }, [meeting.title, editing]);

  const startEditing = useCallback(() => {
    setDraft(meeting.title);
    setRenameError(null);
    setEditing(true);
  }, [meeting.title]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setRenameError(null);
    setDraft(meeting.title);
  }, [meeting.title]);

  const commitRename = useCallback(async () => {
    const title = draft.trim();
    if (!library?.renameMeeting || title === meeting.title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setRenameError(null);
    try {
      const updated = await library.renameMeeting({ id: meeting.id, title });
      onRenamed?.(updated);
      setEditing(false);
    } catch (err: unknown) {
      setRenameError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, library, meeting.id, meeting.title, onRenamed]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEditing();
      }
    },
    [commitRename, cancelEditing],
  );

  const duration = formatDuration(meeting);

  return (
    <article className="mdoc" data-testid="meeting-view" data-meeting-id={meeting.id} data-status={meeting.status}>
      <header className="mdoc__head">
        {onBack && (
          <button type="button" className="mdoc__back" data-testid="meeting-back" onClick={onBack}>
            <Icon name="chevron-left" size={16} aria-hidden="true" />
            Back
          </button>
        )}

        {editing ? (
          <div className="mdoc__rename" data-testid="meeting-rename">
            <input
              ref={inputRef}
              className="mdoc__rename-input"
              data-testid="meeting-rename-input"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Meeting title"
            />
            <button
              type="button"
              className="btn mdoc__rename-save"
              data-testid="meeting-rename-save"
              disabled={saving}
              onClick={() => void commitRename()}
            >
              Save
            </button>
            <button
              type="button"
              className="mdoc__rename-cancel"
              data-testid="meeting-rename-cancel"
              disabled={saving}
              onClick={cancelEditing}
            >
              Cancel
            </button>
          </div>
        ) : (
          <h1 className="mdoc__title" data-testid="meeting-title">
            <span>{displayTitle(meeting)}</span>
            <button
              type="button"
              className="mdoc__rename-trigger"
              data-testid="meeting-rename-trigger"
              onClick={startEditing}
              aria-label="Rename meeting"
            >
              Rename
            </button>
          </h1>
        )}

        {renameError && (
          <p className="mdoc__error" data-testid="meeting-rename-error" role="alert">
            Rename failed: {renameError}
          </p>
        )}

        <div className="mdoc__meta-row">
          <p className="mdoc__meta" data-testid="meeting-meta" data-status={meeting.status}>
            <span>{platformLabel(meeting.platform)}</span>
            {duration && (
              <>
                <span className="mdoc__meta-sep" aria-hidden="true">
                  ·
                </span>
                <span>{duration}</span>
              </>
            )}
          </p>
          <ExportMenu meetingId={meeting.id} api={exportApi} />
        </div>
      </header>

      {processing && (
        <ProcessingStatus jobs={jobs} active={!allJobsTerminal(jobs)} />
      )}

      {/* THE CENTERPIECE: the summary as a document (streamed live, then parsed). */}
      {postReady && (
        <SummaryView
          meetingId={meeting.id}
          reloadKey={summaryReload}
          regenerating={regenerating}
          onRegenerate={() => setRegenerating(true)}
          streamingText={streamingSummary}
        />
      )}

      {/* The transcript is secondary — tucked behind a toggle. */}
      <details className="mdoc__transcript" data-testid="meeting-transcript">
        <summary className="mdoc__transcript-toggle">View transcript</summary>
        <div className="mdoc__transcript-body">
          {load.kind === "loading" && (
            <p className="mdoc__hint" data-testid="meeting-transcript-loading">
              Loading transcript…
            </p>
          )}
          {load.kind === "error" && (
            <p className="mdoc__error" data-testid="meeting-transcript-error" role="alert">
              Could not load transcript: {load.message}
            </p>
          )}
          {load.kind === "loaded" &&
            (load.text.trim().length === 0 ? (
              <p className="mdoc__hint" data-testid="meeting-transcript-empty">
                No transcript yet.
              </p>
            ) : (
              <pre className="mdoc__transcript-text" data-testid="meeting-transcript-text">
                {load.text}
              </pre>
            ))}
        </div>
      </details>

      {/* Docked bottom chat: "Continue chat" about this meeting (read-only). */}
      <div className="mdoc__chat" data-testid="meeting-chat">
        <ChatPanel meetingId={meeting.id} api={chatApi} bare title="Continue chat" />
      </div>
    </article>
  );
}
