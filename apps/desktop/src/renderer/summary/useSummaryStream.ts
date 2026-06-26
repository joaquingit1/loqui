/**
 * useSummaryStream — accumulate the LIVE summary token stream for one meeting.
 *
 * Subscribes to `window.loqui.postprocess.onSummaryToken` and appends each
 * matching {@link SummaryToken} delta into a growing string, so the finished-
 * meeting view can render the summary as it generates (the streamed-summary UX).
 * The stream is live-only (a meeting opened long after its summary was generated
 * receives no tokens — that view reads the parsed `summary.json` instead).
 *
 * `resetKey` clears the buffer when the parent detects a fresh generation (e.g.
 * a summary `jobUpdate` "running", or a Regenerate). The buffer also resets when
 * `meetingId` changes. Talks ONLY to the typed preload bridge (injectable for
 * tests), never to IPC channels.
 */
import { useEffect, useState } from "react";
import type { SummaryToken } from "@loqui/shared";
import type { LoquiPostProcessApi } from "../../preload/index.js";

export interface UseSummaryStreamOptions {
  /** Postprocess bridge (subset). Defaults to window.loqui.postprocess. */
  api?: Pick<LoquiPostProcessApi, "onSummaryToken">;
  /** Bump to clear the accumulated text (e.g. on a new summary "running"). */
  resetKey?: number;
}

export interface UseSummaryStreamResult {
  /** The summary text accumulated so far this generation (""=nothing yet). */
  text: string;
}

export function useSummaryStream(
  meetingId: string | null | undefined,
  options: UseSummaryStreamOptions = {},
): UseSummaryStreamResult {
  const bridge =
    options.api ?? (typeof window !== "undefined" ? window.loqui?.postprocess : undefined);
  const { resetKey } = options;
  const [text, setText] = useState("");

  useEffect(() => {
    setText(""); // reset when the meeting changes or a new generation starts.
    if (!bridge?.onSummaryToken || !meetingId) return;
    const off = bridge.onSummaryToken((token: SummaryToken) => {
      if (token.meetingId !== meetingId) return;
      setText((prev) => prev + token.delta);
    });
    return off;
  }, [bridge, meetingId, resetKey]);

  return { text };
}
