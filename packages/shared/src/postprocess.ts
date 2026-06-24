/**
 * PRD-5 shared post-processing contract: diarization + alignment + AI summary.
 *
 * Defined ONCE in @loqui/shared so the renderer, preload bridge, main IPC
 * handlers + store, and (via the emitted JSON Schema) the Python sidecar all
 * type against a single source — mirroring ./events.ts (JobUpdate) and
 * ./chat.ts.
 *
 * Architecture (post-processing, AFTER the meeting stops — see PRD-5):
 *
 *   main lifecycle: stopMeeting -> status "processing"; after the WAVs are
 *     finalized (the existing `audioFinalized` signal), main sends a
 *     `postProcess` request over the loopback WS to the sidecar.
 *   sidecar: runs the pipeline, emitting `jobUpdate` progress notifications
 *     (kind "diarization" | "summary"):
 *       1) DIARIZATION (offline) on <id>/audio/system.wav ONLY (the "They"
 *          stream; mic is known to be "You") via a DiarizationBackend
 *          (FakeDiarizer for tests; PyannoteDiarizer real). -> speaker turns.
 *       2) ALIGNMENT (pure) assigns those turns to the existing transcript
 *          segments (read transcript.jsonl) by timestamp overlap; mic segments
 *          -> "You", system segments -> Speaker 1/2/...; writes
 *          transcript.diarized.{json,md}.
 *       3) SUMMARY reuses the PRD-4 provider layer (READ-ONLY over the
 *          transcript) -> {tldr, decisions, actionItems, topics}; a separate
 *          summary-writer writes summary.json.
 *   sidecar: on completion notifies main with `postProcessDone` carrying the
 *     data needed to index; MAIN updates the FTS index (diarized text +
 *     summary), meta.participants/speakers, and sets status "done".
 *
 * CROSS-CUTTING INVARIANT (carried over from PRD-4, re-asserted for PRD-5):
 * the AI NEVER edits the transcript. The live transcript (transcript.live.md /
 * the structured transcript.jsonl) + meta.json are written ONLY by main's
 * TranscriptWriter/store. The SUMMARY is AI-generated but is a SEPARATE derived
 * file (summary.json) — the provider stays READ-ONLY over the transcript. The
 * DIARIZED transcript (transcript.diarized.{json,md}) is a DERIVED,
 * deterministic re-labeling (diarization + alignment, NOT AI) — also separate
 * files, never the live transcript. transcript.live.md is byte-identical after
 * diarization + summary.
 *
 * Producers/consumers live in the Build phase; this module defines TYPES + zod
 * schemas only.
 */
import { z } from "zod";
import { audioSourceSchema } from "./audio.js";
import { jobUpdateSchema } from "./events.js";

// --- Speaker labels -----------------------------------------------------------

/**
 * The fixed label assigned to mic ("You") segments after diarization. System
 * ("They") segments get a `Speaker N` label (1-based) per diarized cluster. The
 * speaker-names PRD (PRD-6) later maps `Speaker N` -> a real participant name;
 * until then these are the stable labels shown in the diarized transcript.
 */
export const SPEAKER_YOU_LABEL = "You" as const;

/**
 * Prefix for a remote (system-stream) speaker label. The alignment step assigns
 * `Speaker 1`, `Speaker 2`, … in first-appearance order. Renaming a speaker
 * (see {@link RenameSpeakerParams}) maps one of these labels to a display name.
 */
export const SPEAKER_LABEL_PREFIX = "Speaker" as const;

// --- Diarization (system.wav -> speaker turns) --------------------------------

/**
 * One speaker turn produced by the DiarizationBackend over `system.wav`:
 * `[start, end)` in seconds from meeting start, attributed to a raw diarizer
 * cluster id (`speaker`, e.g. `"spk_0"`). These are NOT yet aligned to the
 * transcript; alignment maps them onto transcript segments and assigns the
 * human-facing `Speaker N` labels.
 */
export const speakerTurnSchema = z.object({
  /** Seconds from meeting start (inclusive). */
  start: z.number().default(0),
  /** Seconds from meeting start (exclusive). */
  end: z.number().default(0),
  /** Raw diarizer cluster id (e.g. "spk_0"); stable within one diarization run. */
  speaker: z.string().min(1),
});
export type SpeakerTurn = z.infer<typeof speakerTurnSchema>;

// --- Diarized transcript segments (alignment output) --------------------------

/**
 * One segment of the DIARIZED transcript: a transcript segment with a resolved
 * speaker label. Mirrors the structured transcript record (segId/tStart/tEnd/
 * source/text) plus the assigned `speaker` label ("You" for mic; "Speaker N"
 * for a system cluster) and the optional rename `displayName`.
 *
 * This is a DERIVED, deterministic re-labeling — NOT an AI write and NOT the
 * live transcript. It lives in transcript.diarized.json (the JSON form) and is
 * rendered to transcript.diarized.md.
 */
export const diarizedSegmentSchema = z.object({
  /** Same segId as the structured transcript segment this row re-labels. */
  segId: z.string().min(1),
  /** Which capture stream the segment came from (mic="You", system="They"). */
  source: audioSourceSchema,
  text: z.string().default(""),
  /** Seconds from meeting start. */
  tStart: z.number().default(0),
  tEnd: z.number().default(0),
  /**
   * Resolved speaker label: {@link SPEAKER_YOU_LABEL} for mic; `"Speaker N"`
   * (see {@link SPEAKER_LABEL_PREFIX}) for a system-stream diarized cluster.
   */
  speaker: z.string().default(SPEAKER_YOU_LABEL),
  /**
   * The renamed display name for this speaker, when the user has renamed it
   * (PRD-5 rename). Null until renamed; the diarized files persist the rename so
   * the `.md` shows the friendly name. `speaker` stays the stable label so a
   * re-diarize/re-render can re-apply renames by label.
   */
  displayName: z.string().nullable().default(null),
});
export type DiarizedSegment = z.infer<typeof diarizedSegmentSchema>;

/**
 * The full diarized-transcript JSON document persisted to
 * `transcript.diarized.json`. `speakers` is the ordered set of distinct
 * `Speaker N` labels discovered in the system stream (plus any rename), so the
 * UI can list/rename speakers without scanning every segment. `diarized` is
 * false when diarization was skipped (no torch/pyannote/HF token) — in that
 * case `segments` is still produced from the live transcript with every system
 * segment labeled a single fallback `Speaker 1` (graceful degradation; the
 * meeting still completes).
 */
export const diarizedTranscriptSchema = z.object({
  meetingId: z.string(),
  /** Schema/version tag so a future re-diarize can detect + replace old output. */
  version: z.number().int().default(1),
  /** Whether real diarization ran (false = skipped/degraded; see above). */
  diarized: z.boolean().default(false),
  /** Diarization backend identifier (e.g. "pyannote/speaker-diarization-3.1", "fake"). */
  backend: z.string().default(""),
  /** Distinct system-stream speaker labels, first-appearance order. */
  speakers: z.array(z.string()).default([]),
  segments: z.array(diarizedSegmentSchema).default([]),
});
export type DiarizedTranscript = z.infer<typeof diarizedTranscriptSchema>;

// --- Summary (AI-generated, read-only over the transcript) --------------------

/** One inferred action item; `owner` is null when no owner could be inferred. */
export const actionItemSchema = z.object({
  text: z.string().default(""),
  owner: z.string().nullable().default(null),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

/**
 * The structured AI summary persisted to `summary.json` by the summary-writer
 * (NOT the provider — the provider stays read-only over the transcript). Shape
 * mirrors PRD-5: TL;DR, key decisions, action items (with owners when
 * inferable), topics. `provider`/`model` echo what produced it.
 */
export const summarySchema = z.object({
  meetingId: z.string(),
  /** Schema/version tag (parallels {@link diarizedTranscriptSchema.version}). */
  version: z.number().int().default(1),
  /** A short overview paragraph. */
  tldr: z.string().default(""),
  /** Key decisions reached. */
  decisions: z.array(z.string()).default([]),
  /** Action items, with an owner when one could be inferred. */
  actionItems: z.array(actionItemSchema).default([]),
  /** Topics discussed. */
  topics: z.array(z.string()).default([]),
  /** Which provider/model produced the summary (active-provider indicator). */
  provider: z.string().default(""),
  model: z.string().default(""),
  /** ISO-8601 timestamp the summary was generated. */
  generatedAt: z.string().default(""),
});
export type Summary = z.infer<typeof summarySchema>;

// --- WS postProcess request (main -> sidecar) ---------------------------------

/**
 * WS notification `event` names for the post-processing protocol. The
 * postProcess REQUEST rides as a `notification` (main -> sidecar) on the
 * existing per-connection sender — NOT a `WsRequest` (those are the fixed
 * ping/getHealth/shutdown enum) — exactly like the PRD-4 chat request, so the
 * additive postprocess path does not touch the PRD-0 request contract. Progress
 * rides as `jobUpdate` notifications (already in ./events.ts); the terminal
 * result rides as a `postProcessDone` notification (sidecar -> main).
 */
export const POSTPROCESS_EVENT = {
  /** main -> sidecar: begin the diarization + alignment + summary pipeline. */
  request: "postProcess",
  /** sidecar -> main: pipeline finished (carries data to index + finalize). */
  done: "postProcessDone",
} as const;

export const POSTPROCESS_REQUEST_EVENT = POSTPROCESS_EVENT.request;
export const POSTPROCESS_DONE_EVENT = POSTPROCESS_EVENT.done;

/**
 * The `postProcess` notification `data` (main -> sidecar). Carries the meeting
 * id + the SAME provider config + transient BYOK api key as a chat request
 * (the summary reuses the PRD-4 provider layer, so it needs the same selection
 * + key, injected out of band by main from the OS keychain — never persisted/
 * logged). `hfToken` is the transient Hugging Face token for the gated pyannote
 * weights, injected by main from the keystore; null/absent when the user has
 * not configured one (diarization then degrades gracefully). `regenerateSummary`
 * runs ONLY the summary step (skipping diarization) for an already-diarized
 * meeting (the regenerate-summary flow). `rediarize` forces diarization to
 * re-run even if prior diarized output exists (idempotent replace).
 */
export const postProcessRequestSchema = z.object({
  meetingId: z.string(),
  /** Provider selection + tuning for the SUMMARY step (mirrors chat). */
  providerConfig: z
    .object({
      provider: z.string().default("fake"),
      model: z.string().default("claude-opus-4-8"),
      baseUrl: z.string().default("http://localhost:11434"),
      ollamaModel: z.string().default("llama3.1"),
      cli: z.string().default("claude"),
    })
    .default({}),
  /**
   * Transient BYOK secret for the summary provider, injected by main from the
   * OS keychain. Optional/nullable (local providers need no key). NEVER
   * persisted or logged by the sidecar.
   */
  apiKey: z.string().nullable().default(null).optional(),
  /**
   * Transient Hugging Face token for the gated pyannote weights, injected by
   * main from the keystore. Null/absent => diarization degrades gracefully.
   * NEVER persisted or logged by the sidecar.
   */
  hfToken: z.string().nullable().default(null).optional(),
  /** Run only the summary step (regenerate); skip diarization. */
  regenerateSummary: z.boolean().default(false),
  /** Force diarization to re-run even if prior output exists (idempotent). */
  rediarize: z.boolean().default(false),
});
export type PostProcessRequest = z.infer<typeof postProcessRequestSchema>;

// --- WS postProcessDone notification (sidecar -> main) ------------------------

/** Per-stage outcome inside {@link PostProcessDone}. */
export const postProcessStageSchema = z.enum(["done", "skipped", "error"]);
export type PostProcessStage = z.infer<typeof postProcessStageSchema>;

/**
 * Terminal post-processing result (sidecar -> main). Carries everything MAIN
 * needs to finalize the meeting: which stages ran, the discovered speaker
 * labels (so meta.participants/speakers can be updated), and the searchable
 * text MAIN should index (diarized transcript text + summary text). The actual
 * files (transcript.diarized.{json,md}, summary.json) are already written by
 * the sidecar; this notification is the signal + index payload, NOT the file
 * bodies. On any stage error the meeting STILL completes (status "done") with
 * whatever succeeded — diarization/summary failures degrade gracefully and are
 * reported per-stage here.
 */
export const postProcessDoneSchema = z.object({
  meetingId: z.string(),
  /** Diarization stage outcome (skipped when torch/pyannote/HF token absent). */
  diarization: postProcessStageSchema.default("skipped"),
  /** Summary stage outcome. */
  summary: postProcessStageSchema.default("skipped"),
  /** Distinct system-stream speaker labels discovered (first-appearance order). */
  speakers: z.array(z.string()).default([]),
  /** Diarization/summary backend+model identifiers, for meta.modelVersions. */
  diarizationBackend: z.string().default(""),
  summaryProvider: z.string().default(""),
  summaryModel: z.string().default(""),
  /**
   * Searchable text MAIN should fold into the FTS index for this meeting: the
   * diarized transcript text + the summary text (concatenated by the sidecar).
   * Empty when nothing new is searchable. MAIN indexes this READ-ONLY (it never
   * rewrites the live transcript).
   */
  indexText: z.string().default(""),
  /** Per-stage human-readable note (e.g. why diarization was skipped). Never a secret. */
  note: z.string().default(""),
});
export type PostProcessDone = z.infer<typeof postProcessDoneSchema>;

// --- Speaker rename (renderer -> main) ----------------------------------------

/**
 * Params for the `renameSpeaker` IPC channel: map a stable speaker label
 * (e.g. `"Speaker 1"`) to a display name for one meeting. main rewrites the
 * diarized files (`displayName` on each matching segment + the `speakers` list),
 * persists the mapping into `meta.participants` (speakerLabel -> name), and
 * re-indexes. Renaming is main-driven + deterministic — NOT an AI write, and it
 * never touches transcript.live.md.
 */
export const renameSpeakerParamsSchema = z.object({
  meetingId: z.string(),
  /** The stable speaker label to rename (e.g. "Speaker 1" or "You"). */
  speaker: z.string().min(1),
  /** The display name to show; empty string clears the rename back to the label. */
  displayName: z.string().default(""),
});
export type RenameSpeakerParams = z.infer<typeof renameSpeakerParamsSchema>;

/** Params for the `regenerateSummary` IPC channel: re-run the summary step. */
export const regenerateSummaryParamsSchema = z.object({
  meetingId: z.string(),
});
export type RegenerateSummaryParams = z.infer<typeof regenerateSummaryParamsSchema>;

/** Params for the `getSummary` IPC channel. */
export const getSummaryParamsSchema = z.object({ meetingId: z.string() });
export type GetSummaryParams = z.infer<typeof getSummaryParamsSchema>;

/** Params for the `getDiarizedTranscript` IPC channel. */
export const getDiarizedTranscriptParamsSchema = z.object({ meetingId: z.string() });
export type GetDiarizedTranscriptParams = z.infer<typeof getDiarizedTranscriptParamsSchema>;

// --- HF token (renderer -> main, via the safeStorage keystore) ----------------

/**
 * Params to store/clear the Hugging Face token (for gated pyannote weights) in
 * the OS keychain via the PRD-4 safeStorage keystore. Pass an empty/null token
 * to CLEAR it. NEVER logged. Mirrors {@link import("./chat.js").SetApiKeyParams}.
 */
export const setHfTokenParamsSchema = z.object({
  token: z.string().nullable().default(null),
});
export type SetHfTokenParams = z.infer<typeof setHfTokenParamsSchema>;

/** Whether an HF token is currently stored (never returns the token). */
export const hfTokenStatusSchema = z.object({
  hasToken: z.boolean().default(false),
});
export type HfTokenStatus = z.infer<typeof hfTokenStatusSchema>;

/**
 * The renderer-facing JobUpdate push payload (main -> renderer): main forwards
 * each sidecar `jobUpdate` notification straight through. Re-exported here as
 * the canonical post-processing progress event so the preload `onJob` bridge
 * has one symbol to type against. (Shape identical to {@link
 * import("./events.js").JobUpdate}.)
 */
export const jobEventSchema = jobUpdateSchema;
export type JobEvent = z.infer<typeof jobEventSchema>;
