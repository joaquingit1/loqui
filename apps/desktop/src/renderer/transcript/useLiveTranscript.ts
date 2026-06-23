/**
 * React hook that drives the live-transcript model from the typed preload
 * bridge (PRD-2). Subscribes to `window.loqui.onTranscriptSegment` (injectable
 * for tests), folds every incoming segment into the pure {@link TranscriptState}
 * via {@link applySegment}, and returns the two independent streams for render.
 *
 * Optionally filters to a single `meetingId` so a stale segment from a previous
 * meeting can't bleed into the current view.
 */
import { useEffect, useRef, useState } from "react";
import type { TranscriptSegment } from "@loqui/shared";
import type { LoquiApi } from "../../preload/index.js";
import {
  applySegment,
  emptyTranscriptState,
  type TranscriptState,
} from "./model.js";

export interface UseLiveTranscriptOptions {
  /**
   * The transcript bridge. Defaults to `window.loqui` (absent in non-Electron
   * renders, in which case the hook simply yields empty streams). Tests inject
   * a fake exposing `onTranscriptSegment`.
   */
  api?: Pick<LoquiApi, "onTranscriptSegment">;
  /**
   * When set, only segments for this meeting are folded in; segments for any
   * other meeting are ignored. Null/undefined accepts all (single-meeting app).
   */
  meetingId?: string | null;
}

export interface UseLiveTranscriptResult {
  /** The two independent streams (mic = "You", system = "They"). */
  state: TranscriptState;
  /** Clear both streams (e.g. when switching meetings). */
  clear(): void;
}

export function useLiveTranscript(
  options: UseLiveTranscriptOptions = {},
): UseLiveTranscriptResult {
  const { api, meetingId } = options;
  const [state, setState] = useState<TranscriptState>(emptyTranscriptState);

  // Keep the latest meeting filter in a ref so the subscription effect doesn't
  // re-subscribe on every meeting change (the filter is read at emit time).
  const meetingRef = useRef<string | null | undefined>(meetingId);
  meetingRef.current = meetingId;

  useEffect(() => {
    const loqui =
      api ?? (typeof window !== "undefined" ? window.loqui : undefined);
    // window.loqui is absent in non-Electron contexts (plain unit render);
    // guard so the view still mounts with empty streams.
    if (!loqui?.onTranscriptSegment) return;

    const unsubscribe = loqui.onTranscriptSegment((segment: TranscriptSegment) => {
      const filter = meetingRef.current;
      if (filter != null && segment.meetingId !== filter) return;
      setState((prev) => applySegment(prev, segment));
    });
    return unsubscribe;
  }, [api]);

  return {
    state,
    clear: () => setState(emptyTranscriptState()),
  };
}
