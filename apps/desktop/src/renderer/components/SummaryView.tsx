/**
 * SummaryView — the AI-generated meeting summary (PRD-5).
 *
 * Loads `<id>/summary.json` via `window.loqui.postprocess.getSummary`
 * (READ-ONLY) and renders the four structured sections: TL;DR, key decisions,
 * action items (with an owner when one was inferred), and topics. A "Regenerate"
 * button fires `regenerateSummary` (a summary-only re-run); progress arrives on
 * the shared {@link useJobProgress} `onJob` stream, so the parent passes a
 * `regenerating` flag + bumps `reloadKey` when the summary job completes to
 * trigger a refetch.
 *
 * CROSS-CUTTING INVARIANT: the summary is AI-generated but is a SEPARATE derived
 * file — the provider stays READ-ONLY over the transcript. This view only reads
 * the summary + asks main to regenerate it; it never writes the transcript.
 *
 * Talks ONLY to the typed `window.loqui.postprocess` bridge (injectable for
 * tests), never to IPC channels or Node globals.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { Summary } from "@loqui/shared";
import type { LoquiPostProcessApi } from "../../preload/index.js";
import { summaryHasContent } from "../summary/index.js";
import { Markdown } from "./Markdown.js";
import "../summary/summary.css";

export interface SummaryViewProps {
  /** The meeting whose summary to load. */
  meetingId: string;
  /** Postprocess bridge (subset). Injectable for tests; defaults to window.loqui.postprocess. */
  api?: Pick<LoquiPostProcessApi, "getSummary" | "regenerateSummary">;
  /**
   * Bumped by the parent (e.g. on a summary "done" JobEvent) to refetch the
   * regenerated summary. Optional.
   */
  reloadKey?: number;
  /** Whether a regenerate is currently in flight (drives the button label). */
  regenerating?: boolean;
  /** Fired when the user clicks Regenerate (after the bridge call is sent). */
  onRegenerate?: () => void;
  /**
   * Live summary text streamed from the sidecar WHILE the summary generates
   * (PRD-2 streamed-summary UX). When non-empty and no parsed `summary.json` has
   * loaded yet, it is rendered as a live preview; once the parsed summary
   * arrives (reloadKey bump on "done") the structured sections replace it.
   */
  streamingText?: string;
  /**
   * Set when the summary JOB failed (e.g. the on-device model is unavailable) —
   * so the absent state can explain + guide instead of implying "still working".
   */
  jobError?: string | null;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "loaded"; summary: Summary }
  | { kind: "error"; message: string };

/**
 * Split a leading `# Title` line off the streamed summary text.
 *
 * The sidecar streams the RAW summary (a leading `# <Title>` line, then the
 * markdown body); it only splits the title into the meeting header when the
 * final `summary.json` is written. So while streaming we peel the title off
 * ourselves — otherwise the user sees a literal `# Reunión…` at the top.
 *
 * While the title itself is still streaming (a first line that starts with `# `
 * but has no newline yet), we surface it as `title` (sans the `#`) and hold the
 * body empty, so the view never flashes a raw `# Reuni…` fragment.
 */
function splitStreamTitle(text: string): { title: string | null; body: string } {
  // Ignore leading blank lines the model may emit before the title.
  const leading = text.replace(/^\s*\n/, "");
  const match = /^#[ \t]+(.*)$/m.exec(leading.split("\n")[0] ?? "");
  if (!match || !leading.startsWith("#")) return { title: null, body: text };

  const newline = leading.indexOf("\n");
  if (newline === -1) {
    // First line is the title, still arriving — show it, no body yet.
    return { title: (match[1] ?? "").trim(), body: "" };
  }
  return { title: (match[1] ?? "").trim(), body: leading.slice(newline + 1).replace(/^\n+/, "") };
}

export function SummaryView({
  meetingId,
  api,
  reloadKey,
  regenerating = false,
  onRegenerate,
  streamingText = "",
  jobError = null,
}: SummaryViewProps): JSX.Element {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.postprocess : undefined);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    if (!bridge?.getSummary) {
      setLoad({ kind: "absent" });
      return;
    }
    bridge
      .getSummary({ meetingId })
      .then((summary) => {
        if (cancelled) return;
        setLoad(summary ? { kind: "loaded", summary } : { kind: "absent" });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, meetingId, reloadKey]);

  const onRegenerateClick = useCallback(() => {
    if (!bridge?.regenerateSummary) return;
    void bridge.regenerateSummary({ meetingId });
    onRegenerate?.();
  }, [bridge, meetingId, onRegenerate]);

  const summary = load.kind === "loaded" ? load.summary : null;
  const canRegenerate = Boolean(bridge?.regenerateSummary);
  // While the summary generates (no parsed summary.json yet), show the live
  // streamed text as the preview in place of the loading/absent hints.
  const showStreaming =
    (load.kind === "loading" || load.kind === "absent") && streamingText.trim().length > 0;

  return (
    <section className="summary" data-testid="summary-view" aria-labelledby="summary-title">
      <div className="summary__bar">
        <div>
          <h3 className="summary__title" id="summary-title">
            Summary
          </h3>
          {summary && (summary.provider || summary.model) && (
            <p className="summary__by" data-testid="summary-provider">
              Generated by {summary.provider}
              {summary.model ? ` · ${summary.model}` : ""}
            </p>
          )}
        </div>
        {canRegenerate && (
          <button
            type="button"
            className="summary__regenerate"
            data-testid="summary-regenerate"
            disabled={regenerating}
            onClick={onRegenerateClick}
          >
            {regenerating ? "Regenerating…" : "Regenerate"}
          </button>
        )}
      </div>

      {showStreaming && (() => {
        // Peel the leading `# Title` line so it renders as the document title
        // (matching the finished view), not as literal `# …` text. Render the
        // rest through the SAME Markdown component as the final overview, so the
        // preview looks like the finished document progressively filling in.
        const { title, body } = splitStreamTitle(streamingText);
        return (
          <div className="summary__streaming" data-testid="summary-streaming" aria-live="polite">
            {title && (
              <h2 className="summary__stream-title" data-testid="summary-stream-title">
                {title}
              </h2>
            )}
            <div className="summary__stream-body">
              <Markdown className="summary__md">{body}</Markdown>
              <span className="summary__stream-caret" aria-hidden="true" />
            </div>
          </div>
        );
      })()}

      {!showStreaming && load.kind === "loading" && (
        <p className="summary__hint" data-testid="summary-loading">
          Loading summary…
        </p>
      )}

      {load.kind === "error" && (
        <p className="summary__error" data-testid="summary-error" role="alert">
          Could not load the summary: {load.message}
        </p>
      )}

      {!showStreaming && load.kind === "absent" && jobError && (
        <p className="summary__error" data-testid="summary-job-error" role="alert">
          Couldn’t generate the summary: {jobError} Enable Apple Intelligence in
          System Settings, or choose a provider in Settings, then Regenerate.
        </p>
      )}

      {!showStreaming && load.kind === "absent" && !jobError && (
        <p className="summary__hint" data-testid="summary-absent">
          No summary yet. It is generated after the meeting is processed.
        </p>
      )}

      {summary && !summaryHasContent(summary) && (
        <p className="summary__hint" data-testid="summary-empty">
          The summary is empty.
        </p>
      )}

      {/* New default: the summary is a markdown DOCUMENT (themed overview). The
          AI title rides on the meeting header (set at finalize), so it's not
          repeated here. Legacy summaries (no overview) fall back to the four
          structured sections below. */}
      {summary && summary.overview.trim().length > 0 && (
        <div className="summary__body" data-testid="summary-overview">
          <Markdown className="summary__md">{summary.overview}</Markdown>
        </div>
      )}

      {summary && summary.overview.trim().length === 0 && summaryHasContent(summary) && (
        <div className="summary__body">
          {summary.tldr.trim().length > 0 && (
            <div className="summary__section" data-testid="summary-tldr">
              <h4 className="summary__section-title">TL;DR</h4>
              <p className="summary__tldr-text">{summary.tldr}</p>
            </div>
          )}

          {summary.decisions.some((d) => d.trim().length > 0) && (
            <div className="summary__section" data-testid="summary-decisions">
              <h4 className="summary__section-title">Decisions</h4>
              <ul className="summary__list">
                {summary.decisions.map((d, i) => (
                  <li key={i} data-testid="summary-decision">
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.actionItems.some((a) => a.text.trim().length > 0) && (
            <div className="summary__section" data-testid="summary-action-items">
              <h4 className="summary__section-title">Action items</h4>
              <ul className="summary__list summary__list--actions">
                {summary.actionItems.map((a, i) => (
                  <li key={i} data-testid="summary-action-item">
                    <span className="summary__action-text">{a.text}</span>
                    {a.owner && a.owner.trim().length > 0 && (
                      <span className="summary__action-owner" data-testid="summary-action-owner">
                        {"— "}
                        {a.owner}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.topics.some((t) => t.trim().length > 0) && (
            <div className="summary__section" data-testid="summary-topics">
              <h4 className="summary__section-title">Topics</h4>
              <ul className="summary__chips">
                {summary.topics.map((t, i) => (
                  <li key={i} className="summary__chip" data-testid="summary-topic">
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
