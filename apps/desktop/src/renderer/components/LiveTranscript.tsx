/**
 * Live transcript view (PRD-2) — the editorial flowing stream (DESIGN-SYSTEM
 * §9.10).
 *
 * Both audio streams — mic ("You") and system ("They") — are folded by
 * {@link useLiveTranscript} into the pure transcript model, then merged into ONE
 * time-ordered flow ({@link mergedSegments}) and rendered as a single calm
 * column of lines: a faint `--text-mono` timestamp + a speaker label (You in
 * `--accent-ink`, They in `--text-dim`) + the text in `--text-body-lg`. This is
 * deliberately NOT two side-by-side chat columns — it reads like a transcript,
 * not a chat log. Within the flow, `partial` segments render in place (dimmed,
 * keyed by `segId`) and are replaced by their `final` once committed.
 *
 * New lines fade/slide in (`--duration-base`). The view sticks to the bottom as
 * speech arrives but pauses the moment the user scrolls up to read back, exposing
 * a "Jump to live" affordance, and resumes once they return to the bottom.
 *
 * All capture/transport state lives elsewhere; this component is presentation +
 * the auto-scroll interaction. It talks ONLY to the typed `window.loqui` bridge
 * (via the hook), never to IPC channels or Node globals.
 */
import { useCallback, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { AudioSource } from "@loqui/shared";
import type { LoquiApi } from "../../preload/index.js";
import { Icon } from "./Icon.js";
import {
  mergedSegments,
  SOURCE_LABEL,
  useLiveTranscript,
} from "../transcript/index.js";
import "../transcript/transcript.css";

export interface LiveTranscriptProps {
  /** Restrict the view to one meeting; null/undefined accepts all. */
  meetingId?: string | null;
  /** Injectable for tests; defaults to window.loqui via the hook. */
  api?: Pick<LoquiApi, "onTranscriptSegment">;
}

/** Distance from the bottom (px) still considered "at the bottom". */
const STICK_THRESHOLD_PX = 24;

/** Format a media-time offset (seconds) as a faint m:ss timestamp. */
function formatStamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

export function LiveTranscript({ meetingId, api }: LiveTranscriptProps): JSX.Element {
  const { state } = useLiveTranscript({ api, meetingId });
  const lines = mergedSegments(state);

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
  }, [lines, stickToBottom]);

  const jumpToLive = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
  }, []);

  return (
    <section
      className="transcript"
      aria-labelledby="transcript-title"
      data-testid="live-transcript"
    >
      <h2 className="transcript__title" id="transcript-title">
        Transcript
      </h2>

      <div
        className="transcript__flow"
        data-testid="transcript-flow"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Live transcript"
      >
        {lines.length === 0 ? (
          <p className="transcript__empty" data-testid="transcript-empty">
            <Icon name="mic" size={20} aria-hidden="true" />
            <span>Listening — the transcript appears here as people speak.</span>
          </p>
        ) : (
          lines.map((seg) => (
            <TranscriptLine key={`${seg.source}-${seg.segId}`} source={seg.source}>
              {{ segId: seg.segId, status: seg.status, tStart: seg.tStart, text: seg.text }}
            </TranscriptLine>
          ))
        )}
      </div>

      {!stickToBottom && lines.length > 0 && (
        <button
          type="button"
          className="transcript__jump"
          data-testid="transcript-jump"
          onClick={jumpToLive}
        >
          Jump to live
          <Icon name="arrow-down" size={14} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

interface TranscriptLineData {
  segId: string;
  status: "partial" | "final";
  tStart: number;
  text: string;
}

function TranscriptLine({
  source,
  children,
}: {
  source: AudioSource;
  children: TranscriptLineData;
}): JSX.Element {
  const { segId, status, tStart, text } = children;
  const label = SOURCE_LABEL[source];
  return (
    <p
      className={`transcript__line transcript__line--${status} transcript__line--${source}`}
      data-testid={`segment-${source}-${segId}`}
      data-status={status}
      data-source={source}
      data-seg-id={segId}
    >
      <span className="transcript__stamp">{formatStamp(tStart)}</span>
      <span className={`transcript__who transcript__who--${source}`}>{label}</span>
      <span className="transcript__text">{text}</span>
    </p>
  );
}
