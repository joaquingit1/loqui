/**
 * Live two-stream transcript view (PRD-2).
 *
 * Renders the mic ("You") and system ("They") transcripts as two visually
 * distinct, INDEPENDENT columns fed by {@link useLiveTranscript} (which folds
 * `window.loqui.onTranscriptSegment` into the pure transcript model). Within a
 * column, `partial` segments render in place (dimmed, keyed by `segId`) and are
 * replaced by their `final` once committed; finals render solid.
 *
 * Auto-scroll behavior: each column sticks to the bottom as new segments
 * arrive, BUT pauses auto-scroll the moment the user scrolls up to read back,
 * and resumes once they scroll back to (near) the bottom. A "Jump to live"
 * affordance appears while paused.
 *
 * All capture/transport state lives elsewhere; this component is presentation +
 * the auto-scroll interaction. It talks ONLY to the typed `window.loqui` bridge
 * (via the hook), never to IPC channels or Node globals.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AudioSource } from "@loqui/shared";
import type { LoquiApi } from "../../preload/index.js";
import {
  SOURCE_LABEL,
  TRANSCRIPT_SOURCES,
  useLiveTranscript,
  type StreamState,
} from "../transcript/index.js";
import "../transcript/transcript.css";

export interface LiveTranscriptProps {
  /** Restrict the view to one meeting; null/undefined accepts all. */
  meetingId?: string | null;
  /** Injectable for tests; defaults to window.loqui via the hook. */
  api?: Pick<LoquiApi, "onTranscriptSegment">;
}

export function LiveTranscript({ meetingId, api }: LiveTranscriptProps): JSX.Element {
  const { state } = useLiveTranscript({ api, meetingId });
  const total = state.mic.length + state.system.length;

  return (
    <section
      className="panel transcript"
      aria-labelledby="transcript-title"
      data-testid="live-transcript"
    >
      <h2 className="panel__title" id="transcript-title">
        Live transcript
      </h2>
      <p className="panel__subtitle">
        Mic (You) and system (They) are transcribed as two independent streams.
      </p>

      <div className="transcript__columns">
        {TRANSCRIPT_SOURCES.map((source) => (
          <TranscriptColumn key={source} source={source} segments={state[source]} />
        ))}
      </div>

      {total === 0 && (
        <p className="transcript__empty" data-testid="transcript-empty">
          Waiting for speech…
        </p>
      )}
    </section>
  );
}

interface TranscriptColumnProps {
  source: AudioSource;
  segments: StreamState;
}

/** Distance from the bottom (px) still considered "at the bottom". */
const STICK_THRESHOLD_PX = 24;

function TranscriptColumn({ source, segments }: TranscriptColumnProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether to keep pinning to the bottom on new content. Flipped off when the
  // user scrolls up, back on when they return to the bottom.
  const [stickToBottom, setStickToBottom] = useState(true);

  const atBottom = useCallback((el: HTMLDivElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setStickToBottom(atBottom(el));
  }, [atBottom]);

  // Auto-scroll on new/updated segments while pinned. useLayoutEffect so the
  // jump happens before paint (no flicker). jsdom doesn't lay out, so the guard
  // below keeps tests deterministic.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [segments, stickToBottom]);

  const jumpToLive = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }, []);

  const label = SOURCE_LABEL[source];

  return (
    <div
      className={`transcript__stream transcript__stream--${source}`}
      data-testid={`transcript-stream-${source}`}
      data-source={source}
    >
      <div className="transcript__stream-header">
        <span className={`transcript__who transcript__who--${source}`}>{label}</span>
        <span className="transcript__source-tag">
          {source === "mic" ? "mic" : "system"}
        </span>
      </div>

      <div
        className="transcript__lines"
        data-testid={`transcript-lines-${source}`}
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label={`${label} transcript`}
      >
        {segments.map((seg) => (
          <p
            key={seg.segId}
            className={`transcript__line transcript__line--${seg.status}`}
            data-testid={`segment-${source}-${seg.segId}`}
            data-status={seg.status}
            data-seg-id={seg.segId}
          >
            {seg.text}
          </p>
        ))}
      </div>

      {!stickToBottom && (
        <button
          type="button"
          className="transcript__jump"
          data-testid={`transcript-jump-${source}`}
          onClick={jumpToLive}
        >
          Jump to live ↓
        </button>
      )}
    </div>
  );
}
