/**
 * Main-process transcript forwarding (PRD-2, unit "renderer-live-transcript").
 *
 * Subscribes to the sidecar's server-initiated WS notifications via the existing
 * supervisor notification fan-out (`supervisor.onNotification`, wired by the
 * Foundation; survives reconnects), filters to the single
 * {@link TRANSCRIPT_SEGMENT_EVENT} event, validates + normalizes each payload
 * with {@link transcriptSegmentSchema}, and pushes the parsed
 * {@link TranscriptSegment} to the live renderer window on
 * {@link IPC.transcriptSegment}.
 *
 * This reuses the exact PRD-1 status/notification transport — there is NO new
 * wire. It is the canonical, headless-testable implementation behind the
 * Foundation's `pushTranscriptSegments` (ipc/register.ts); both keep an
 * identical contract so the main → renderer hop is covered by a focused
 * hermetic unit test (forward.test.ts) with a mocked supervisor + window.
 *
 * Robustness contract (matches the rest of main): a malformed segment is
 * DROPPED, never forwarded; a destroyed/absent window is skipped; the
 * subscriber never throws into the supervisor's fan-out loop.
 */
import type { BrowserWindow } from "electron";
import {
  TRANSCRIPT_SEGMENT_EVENT,
  transcriptSegmentSchema,
  type TranscriptSegment,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { SidecarSupervisor } from "../sidecar/supervisor.js";

/** The narrow supervisor surface the forwarder needs (kept minimal for tests). */
export type TranscriptSupervisor = Pick<SidecarSupervisor, "onNotification">;

/**
 * A minimal sink for one validated segment. The default
 * {@link forwardTranscriptSegments} sink sends on {@link IPC.transcriptSegment}
 * to the live window; tests inject a spy so no Electron window is needed.
 */
export type TranscriptSegmentSink = (segment: TranscriptSegment) => void;

/**
 * Resolve a sink that pushes a validated segment to whatever window is live at
 * emit time (so the push survives window recreation). A destroyed/null window
 * is skipped silently.
 */
export function windowSink(
  getWindow: () => BrowserWindow | null,
): TranscriptSegmentSink {
  return (segment: TranscriptSegment) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.transcriptSegment, segment);
    }
  };
}

/**
 * Validate one raw notification payload as a {@link TranscriptSegment}. Returns
 * the parsed (and default-normalized) segment, or null if it is malformed.
 * Exposed so callers/tests can reuse the exact drop-malformed semantics.
 */
export function parseTranscriptSegment(data: unknown): TranscriptSegment | null {
  const parsed = transcriptSegmentSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Subscribe to the supervisor's notification fan-out and forward every valid
 * `transcriptSegment` notification to `sink`. Returns an unsubscribe fn.
 *
 * - Notifications whose event is not {@link TRANSCRIPT_SEGMENT_EVENT} are
 *   ignored (other event kinds — e.g. jobUpdate — flow past untouched).
 * - A payload that fails {@link transcriptSegmentSchema} is dropped, never sent.
 * - The sink is wrapped so a throwing sink cannot break the supervisor's WS
 *   fan-out loop (the supervisor already guards, but we double-insulate here so
 *   this module is safe to use with any sink).
 */
export function forwardTranscriptSegments(
  supervisor: TranscriptSupervisor,
  sink: TranscriptSegmentSink,
): () => void {
  return supervisor.onNotification((event: string, data: unknown) => {
    if (event !== TRANSCRIPT_SEGMENT_EVENT) return;
    const segment = parseTranscriptSegment(data);
    if (!segment) return; // drop malformed; never forward.
    try {
      sink(segment);
    } catch {
      /* a throwing sink must not break supervision or the WS loop */
    }
  });
}

/**
 * Convenience wiring used by main: forward sidecar transcript notifications to
 * the live renderer window on {@link IPC.transcriptSegment}. Equivalent to the
 * Foundation's `pushTranscriptSegments` and kept contract-identical. Returns an
 * unsubscribe fn.
 */
export function pushTranscriptSegmentsToWindow(
  supervisor: TranscriptSupervisor,
  getWindow: () => BrowserWindow | null,
): () => void {
  return forwardTranscriptSegments(supervisor, windowSink(getWindow));
}
