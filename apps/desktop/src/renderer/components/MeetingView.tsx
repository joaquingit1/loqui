/**
 * Meeting view (PRD-3): opens one meeting and renders its `transcript.live.md`
 * (read via `window.loqui.library.getTranscript`, READ-ONLY), with an inline,
 * persisted title rename.
 *
 * This is a READER of the transcript — it never writes the file (the
 * append-only TranscriptWriter in main owns that). Rename goes through the
 * `renameMeeting` IPC, which persists to meta.json + the index; on success the
 * returned, fully-validated Meeting is lifted back to the parent so the Library
 * row updates without a re-list.
 *
 * Talks ONLY to the typed `window.loqui.library` bridge — never to IPC channels
 * or Node globals.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Meeting } from "@loqui/shared";
import type { LoquiLibraryApi } from "../../preload/index.js";
import {
  displayTitle,
  formatDuration,
  platformLabel,
  statusLabel,
} from "../library/grouping.js";
import { SummaryView } from "./SummaryView.js";
import { DiarizedTranscript } from "./DiarizedTranscript.js";
import { ProcessingStatus } from "./ProcessingStatus.js";
import { useJobProgress, allJobsTerminal } from "../summary/index.js";
import "../library/library.css";

export interface MeetingViewProps {
  /** The meeting to display. */
  meeting: Meeting;
  /** Library bridge (subset). Injectable for tests; defaults to window.loqui.library. */
  api?: Pick<LoquiLibraryApi, "getTranscript" | "renameMeeting">;
  /** Navigate back to the Library list. */
  onBack?: () => void;
  /** Fired with the updated Meeting after a successful rename. */
  onRenamed?: (meeting: Meeting) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "error"; message: string };

export function MeetingView({ meeting, api, onBack, onRenamed }: MeetingViewProps): JSX.Element {
  const library = (api ?? window.loqui?.library) as MeetingViewProps["api"] | undefined;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  // PRD-5 post-processing: live job progress (diarization + summary). When a
  // job completes, bump reload keys so the Summary + DiarizedTranscript views
  // refetch the freshly written derived files. Regenerating tracks a
  // summary-only re-run so the Summary view's button reflects the in-flight
  // state and refetches on completion.
  const [summaryReload, setSummaryReload] = useState(0);
  const [diarizedReload, setDiarizedReload] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const { jobs } = useJobProgress({
    onEvent: (event) => {
      if (event.kind === "summary" && (event.state === "done" || event.state === "error")) {
        setSummaryReload((n) => n + 1);
        setRegenerating(false);
      }
      if (event.kind === "diarization" && (event.state === "done" || event.state === "error")) {
        setDiarizedReload((n) => n + 1);
      }
    },
  });
  const processing = meeting.status === "processing";
  const postReady = meeting.status === "done" || meeting.status === "processing";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meeting.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load the transcript whenever the target meeting changes.
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
  }, [library, meeting.id]);

  // Keep the rename draft in sync when the underlying meeting changes (and we're not mid-edit).
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
    if (!library?.renameMeeting) {
      setEditing(false);
      return;
    }
    if (title === meeting.title) {
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
    <section className="panel meeting-view" data-testid="meeting-view" data-meeting-id={meeting.id}>
      <div className="meeting-view__top">
        {onBack && (
          <button
            type="button"
            className="meeting-view__back"
            data-testid="meeting-back"
            onClick={onBack}
          >
            ← Library
          </button>
        )}

        {editing ? (
          <div className="meeting-view__rename" data-testid="meeting-rename">
            <input
              ref={inputRef}
              className="meeting-view__rename-input"
              data-testid="meeting-rename-input"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label="Meeting title"
            />
            <button
              type="button"
              className="btn meeting-view__rename-save"
              data-testid="meeting-rename-save"
              disabled={saving}
              onClick={() => void commitRename()}
            >
              Save
            </button>
            <button
              type="button"
              className="meeting-view__rename-cancel"
              data-testid="meeting-rename-cancel"
              disabled={saving}
              onClick={cancelEditing}
            >
              Cancel
            </button>
          </div>
        ) : (
          <h2 className="meeting-view__title" data-testid="meeting-title">
            <span>{displayTitle(meeting)}</span>
            <button
              type="button"
              className="meeting-view__rename-trigger"
              data-testid="meeting-rename-trigger"
              onClick={startEditing}
              aria-label="Rename meeting"
            >
              Rename
            </button>
          </h2>
        )}
      </div>

      {renameError && (
        <p className="meeting-view__error" data-testid="meeting-rename-error" role="alert">
          Rename failed: {renameError}
        </p>
      )}

      <dl className="meeting-view__meta" data-testid="meeting-meta">
        <div>
          <dt>Platform</dt>
          <dd>{platformLabel(meeting.platform)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd data-status={meeting.status}>{statusLabel(meeting.status)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{duration ?? "—"}</dd>
        </div>
      </dl>

      <div className="meeting-view__transcript" data-testid="meeting-transcript">
        {load.kind === "loading" && (
          <p className="meeting-view__hint" data-testid="meeting-transcript-loading">
            Loading transcript…
          </p>
        )}
        {load.kind === "error" && (
          <p className="meeting-view__error" data-testid="meeting-transcript-error" role="alert">
            Could not load transcript: {load.message}
          </p>
        )}
        {load.kind === "loaded" &&
          (load.text.trim().length === 0 ? (
            <p className="meeting-view__hint" data-testid="meeting-transcript-empty">
              No transcript yet.
            </p>
          ) : (
            <pre className="meeting-view__transcript-text" data-testid="meeting-transcript-text">
              {load.text}
            </pre>
          ))}
      </div>

      {processing && (
        // Post-meeting diarization + summary are still running (PRD-5).
        <ProcessingStatus jobs={jobs} active={!allJobsTerminal(jobs)} />
      )}

      {postReady && (
        <>
          <SummaryView
            meetingId={meeting.id}
            reloadKey={summaryReload}
            regenerating={regenerating}
            onRegenerate={() => setRegenerating(true)}
          />
          <DiarizedTranscript meetingId={meeting.id} reloadKey={diarizedReload} />
        </>
      )}
    </section>
  );
}
