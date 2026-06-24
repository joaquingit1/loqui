/**
 * DiarizedTranscript — the speaker-labeled transcript view (PRD-5).
 *
 * Loads `<id>/transcript.diarized.json` via
 * `window.loqui.postprocess.getDiarizedTranscript` (READ-ONLY) and renders one
 * line per segment grouped by speaker: the local user's mic stream as "You",
 * each remote (system-stream) cluster as "Speaker N" (or its rename). A speaker
 * roster at the top offers inline {@link SpeakerRename} for each label; a rename
 * calls `renameSpeaker`, which returns the updated diarized transcript that we
 * lift into state so the lines + roster re-label immediately.
 *
 * This is a DERIVED, deterministic re-labeling — NOT the live transcript and
 * NOT an AI write. Renames are main-driven (they rewrite the derived files +
 * index); this component never touches transcript.live.md.
 *
 * Talks ONLY to the typed `window.loqui.postprocess` bridge (injectable for
 * tests), never to IPC channels or Node globals.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { SPEAKER_YOU_LABEL, type DiarizedTranscript as DiarizedTranscriptDoc } from "@loqui/shared";
import type { LoquiPostProcessApi } from "../../preload/index.js";
import { formatTimecode, isYou, speakerDisplay, speakerEntries } from "../summary/index.js";
import { SpeakerRename } from "./SpeakerRename.js";
import "../summary/summary.css";

export interface DiarizedTranscriptProps {
  /** The meeting whose diarized transcript to load. */
  meetingId: string;
  /** Postprocess bridge (subset). Injectable for tests; defaults to window.loqui.postprocess. */
  api?: Pick<LoquiPostProcessApi, "getDiarizedTranscript" | "renameSpeaker">;
  /**
   * Bumped by the parent (e.g. on a diarization "done" JobEvent) to force a
   * reload after re-processing. Optional.
   */
  reloadKey?: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "loaded"; doc: DiarizedTranscriptDoc }
  | { kind: "error"; message: string };

export function DiarizedTranscript({ meetingId, api, reloadKey }: DiarizedTranscriptProps): JSX.Element {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.postprocess : undefined);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    if (!bridge?.getDiarizedTranscript) {
      setLoad({ kind: "absent" });
      return;
    }
    bridge
      .getDiarizedTranscript({ meetingId })
      .then((doc) => {
        if (cancelled) return;
        setLoad(doc ? { kind: "loaded", doc } : { kind: "absent" });
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

  const onRename = useCallback(
    async (label: string, displayName: string) => {
      if (!bridge?.renameSpeaker) return;
      setRenaming(true);
      try {
        const updated = await bridge.renameSpeaker({ meetingId, speaker: label, displayName });
        setLoad({ kind: "loaded", doc: updated });
      } finally {
        setRenaming(false);
      }
    },
    [bridge, meetingId],
  );

  const doc = load.kind === "loaded" ? load.doc : null;
  const speakers = useMemo(() => (doc ? speakerEntries(doc) : []), [doc]);

  return (
    <section className="diarized" data-testid="diarized-transcript" aria-labelledby="diarized-title">
      <div className="diarized__bar">
        <h3 className="diarized__title" id="diarized-title">
          Speakers
        </h3>
        {doc && (
          <span
            className={`diarized__badge diarized__badge--${doc.diarized ? "on" : "off"}`}
            data-testid="diarized-badge"
            data-diarized={doc.diarized ? "true" : "false"}
          >
            {doc.diarized ? "Diarized" : "Diarization skipped"}
          </span>
        )}
      </div>

      {load.kind === "loading" && (
        <p className="diarized__hint" data-testid="diarized-loading">
          Loading speaker-labeled transcript…
        </p>
      )}

      {load.kind === "error" && (
        <p className="diarized__error" data-testid="diarized-error" role="alert">
          Could not load the diarized transcript: {load.message}
        </p>
      )}

      {load.kind === "absent" && (
        <p className="diarized__hint" data-testid="diarized-absent">
          No speaker-labeled transcript yet. It is generated after the meeting is processed.
        </p>
      )}

      {doc && (
        <>
          {!doc.diarized && (
            <p className="diarized__note" data-testid="diarized-degraded-note" role="note">
              Diarization was skipped, so remote speech is grouped under a single speaker. The
              transcript and summary are still complete.
            </p>
          )}

          <div className="diarized__roster" data-testid="diarized-roster">
            {speakers.map((s) => (
              <div
                className={`diarized__roster-item${s.label === SPEAKER_YOU_LABEL ? " diarized__roster-item--you" : ""}`}
                key={s.label}
                data-testid={`diarized-roster-${s.label}`}
              >
                <SpeakerRename
                  label={s.label}
                  displayName={s.displayName}
                  onRename={onRename}
                  disabled={renaming}
                />
              </div>
            ))}
          </div>

          <ol className="diarized__lines" data-testid="diarized-lines">
            {doc.segments.length === 0 ? (
              <li className="diarized__hint" data-testid="diarized-empty">
                No speech segments.
              </li>
            ) : (
              doc.segments.map((seg, i) => (
                <li
                  className={`diarized__line${isYou(seg) ? " diarized__line--you" : ""}`}
                  key={seg.segId || `${seg.speaker}-${i}`}
                  data-testid="diarized-line"
                  data-speaker={seg.speaker}
                  data-source={seg.source}
                >
                  <span className="diarized__line-who" data-testid="diarized-line-speaker">
                    {speakerDisplay(seg)}
                  </span>
                  <span className="diarized__line-time">{formatTimecode(seg.tStart)}</span>
                  <span className="diarized__line-text">{seg.text}</span>
                </li>
              ))
            )}
          </ol>
        </>
      )}
    </section>
  );
}
