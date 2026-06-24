/**
 * PRD-6 — main-process speaker-names seams (interfaces / signatures ONLY).
 *
 * This file is the Foundation seam the PRD-6 Build units implement against:
 *   - Build unit A (WS server + buffer): implements {@link ExtensionWsServer} —
 *     a LOOPBACK-ONLY (127.0.0.1) WebSocket server that accepts the browser
 *     extension's {@link import("@loqui/shared").ExtensionMessage} frames,
 *     associates a connected Meet tab with the CURRENT Loqui meeting, and
 *     BUFFERS {@link import("@loqui/shared").SpeakerActivityEvent}s only while a
 *     meeting is active (IGNORES events when none is) — plus `register.ts` (the
 *     IPC bridge + status push).
 *   - Build unit B (correlation + applier): implements the PURE
 *     {@link CorrelateSpeakerNames} engine and the {@link SpeakerNameApplier}
 *     that REUSES the postprocess diarized-rewrite path.
 *   - Build unit C (extension): the apps/extension content script + swappable
 *     selectors that produce the events (typed against @loqui/shared only).
 *
 * ARCHITECTURE (decisive): TS-only; the Python sidecar is NOT touched. The WS
 * server here is a NEW server in MAIN (distinct from the sidecar WS, where main
 * is a client). It binds {@link import("@loqui/shared").SPEAKERNAMES_WS_HOST}
 * (127.0.0.1) ONLY.
 *
 * #1 INVARIANT — GRACEFUL DEGRADATION (non-negotiable): a missing/broken
 * extension, a selector miss, a malformed frame, clock skew, or zero activity
 * MUST leave the meeting completing with generic `Speaker N` labels and NO
 * error/crash/bad data. Every signature below is shaped so the "do nothing,
 * keep generic labels" path is the easy, total one: the correlation engine is
 * PURE and may return an empty result; the applier no-ops on an empty/low-
 * confidence result; the server drops unparseable frames.
 *
 * NAME-APPLY REUSE: the applier MUST NOT fork the diarized-rewrite path. It maps
 * resolved `Speaker N` -> name by calling the SAME mechanism PRD-5's
 * `renameSpeaker` uses (rewrite transcript.diarized.{json,md} + meta.participants
 * + re-index). MANUAL renames always win: a speaker whose participant already
 * carries a user-set name is never overwritten by an auto-resolved name.
 */
import type {
  Meeting,
  SpeakerActivityEvent,
  SpeakerCorrelationParams,
  SpeakerCorrelationResult,
  SpeakerNamesStatus,
  DiarizedTranscript,
} from "@loqui/shared";

// --- WS server (extension -> main) --------------------------------------------

/**
 * The slice of the meeting lifecycle the WS server needs to know which meeting
 * (if any) is currently recording, so it buffers activity for that meeting and
 * IGNORES events when none is active. Injected so tests drive it with a fake.
 * `getActiveMeeting` returns the live recording Meeting or null; `onActiveMeetingChange`
 * lets the server flush/rotate its buffer on start/stop. Mirrors the controller
 * the PRD-3/PRD-5 lifecycle already exposes — the Build unit adapts it.
 */
export interface ActiveMeetingSource {
  /** The currently-recording meeting, or null when none is active. */
  getActiveMeeting(): Meeting | null;
  /** Subscribe to active-meeting changes (start sets, stop clears). Returns unsubscribe. */
  onActiveMeetingChange(cb: (meeting: Meeting | null) => void): () => void;
}

/**
 * The buffered activity for one meeting, returned to the correlation hook after
 * `postProcessDone`. `events` are the {@link SpeakerActivityEvent}s captured
 * (in arrival order); `participants` is the distinct set of names seen. Empty
 * when the extension was absent/broken — the correlation hook then applies
 * nothing (graceful degradation).
 */
export interface BufferedMeetingActivity {
  meetingId: string;
  events: SpeakerActivityEvent[];
  participants: string[];
}

/**
 * SIGNATURE Build unit A implements: the loopback-only extension WS server.
 * `start` binds {@link import("@loqui/shared").SPEAKERNAMES_WS_HOST}:port (port
 * defaulting to {@link import("@loqui/shared").SPEAKERNAMES_WS_DEFAULT_PORT}) and
 * resolves with the bound address so tests can ASSERT it is loopback. It accepts
 * the extension envelope, buffers activity ONLY while a meeting is active, drops
 * unparseable/inactive frames, and tracks connection status. `drainActivity`
 * hands the buffer for a meeting to the correlation hook (and clears it).
 */
export interface ExtensionWsServer {
  /** Bind the loopback listener; resolves with the bound {host, port}. */
  start(): Promise<{ host: string; port: number }>;
  /** Current extension-connection/capture status (for the status invoke). */
  getStatus(): SpeakerNamesStatus;
  /** Subscribe to status changes (connect/disconnect/capture). Returns unsubscribe. */
  onStatusChange(cb: (status: SpeakerNamesStatus) => void): () => void;
  /** Take + clear the buffered activity for a meeting (empty when none captured). */
  drainActivity(meetingId: string): BufferedMeetingActivity;
  /** Stop the listener + drop all connections + clear buffers. Idempotent. */
  stop(): Promise<void>;
}

/** Options to construct the WS server (Build unit A). Port/host defaulted from @loqui/shared. */
export interface ExtensionWsServerDeps {
  activeMeeting: ActiveMeetingSource;
  /** Override the loopback port (tests pass 0 for an OS-assigned loopback port). */
  port?: number;
}
export type CreateExtensionWsServer = (deps: ExtensionWsServerDeps) => ExtensionWsServer;

// --- Correlation engine (PURE) ------------------------------------------------

/**
 * SIGNATURE Build unit B implements: the PURE correlation engine. Given the
 * diarized transcript (the system-stream `Speaker N` turns) and the buffered
 * activity events, overlap each speaker's turn intervals with each participant's
 * speaking intervals (reconciling the epoch-ms `ts` against seconds-from-start
 * via `params.meetingStartEpochMs` + `skewToleranceMs`), and emit a confidence-
 * aware {@link SpeakerCorrelationResult}. NO I/O, NO Date.now, NO randomness —
 * deterministic from its inputs so it is fully fixture-driven in tests. MUST
 * handle gaps, overlaps, unknown speakers, and ambiguity (ambiguous turns get
 * `apply:false` => stay `Speaker N`). An empty `activity` yields an empty result.
 */
export type CorrelateSpeakerNames = (
  diarized: DiarizedTranscript,
  activity: SpeakerActivityEvent[],
  params?: SpeakerCorrelationParams,
) => SpeakerCorrelationResult;

// --- Name applier (REUSES the PRD-5 diarized-rewrite path) --------------------

/**
 * The minimal slice of the meeting store the applier needs — IDENTICAL to the
 * PRD-5 rename path's `store` shape — so the applier REUSES that mechanism
 * rather than forking it.
 */
export interface SpeakerNameApplierStore {
  getMeeting: import("../store/index.js").MeetingStore["getMeeting"];
  updateMeeting: import("../store/index.js").MeetingStore["updateMeeting"];
  getSummary: import("../store/index.js").MeetingStore["getSummary"];
  getDiarizedTranscript: import("../store/index.js").MeetingStore["getDiarizedTranscript"];
  upsertSearchText: import("../store/index.js").MeetingStore["upsertSearchText"];
}

/**
 * SIGNATURE Build unit B implements: apply a {@link SpeakerCorrelationResult} by
 * REUSING the PRD-5 diarized-rewrite path (rewrite transcript.diarized.{json,md}
 * + meta.participants + re-index) for each resolution whose `apply` is true.
 * MANUAL renames always win — a speaker whose participant already has a user-set
 * name is SKIPPED. An empty/all-`apply:false` result is a NO-OP (and a no-op
 * never touches transcript.live.md / transcript.jsonl — those stay byte-identical).
 * Returns the resulting diarized transcript (unchanged when nothing applied).
 */
export type SpeakerNameApplier = (
  store: SpeakerNameApplierStore,
  result: SpeakerCorrelationResult,
) => DiarizedTranscript | null;

// --- IPC bridge + status push (main -> renderer) ------------------------------

/**
 * SIGNATURE Build unit A implements in `register.ts`: bind the speaker-names IPC
 * channels (status invoke + the status push) to the {@link ExtensionWsServer}.
 * Returns a disposer (mirrors registerMcpIpc / registerCalendarIpc). `getWindow`
 * resolves the live window at emit time so the push survives window recreation.
 */
export interface SpeakerNamesIpcDeps {
  server: Pick<ExtensionWsServer, "getStatus" | "onStatusChange">;
  getWindow: () => import("electron").BrowserWindow | null;
}
export type RegisterSpeakerNamesIpc = (deps: SpeakerNamesIpcDeps) => () => void;

/**
 * SIGNATURE Build unit B implements: the post-diarization correlation hook main
 * invokes after `postProcessDone` for a meeting. It drains the WS server's
 * buffered activity for the meeting, runs the PURE {@link CorrelateSpeakerNames}
 * engine against the freshly-written diarized transcript, and applies the result
 * via the {@link SpeakerNameApplier}. TOTAL + best-effort: any failure (no
 * activity, parse error, applier error) is swallowed + logged so the meeting
 * still completes with generic labels. Returns the applied result (or null when
 * nothing was applied) for diagnostics/tests.
 */
export interface SpeakerNamesCorrelationHookDeps {
  server: Pick<ExtensionWsServer, "drainActivity">;
  store: SpeakerNameApplierStore;
  correlate: CorrelateSpeakerNames;
  apply: SpeakerNameApplier;
}
export type RunSpeakerNamesCorrelation = (
  deps: SpeakerNamesCorrelationHookDeps,
  meetingId: string,
) => SpeakerCorrelationResult | null;
