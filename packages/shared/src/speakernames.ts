/**
 * PRD-6 — shared Google-Meet speaker-name attribution contract seams.
 *
 * The single source of truth for the cross-process shapes the three PRD-6 Build
 * units type against:
 *   - the **browser extension** (apps/extension) emits {@link SpeakerActivityEvent}s
 *     wrapped in a small {@link ExtensionMessage} envelope (hello/activity/bye)
 *     over a LOOPBACK WebSocket;
 *   - the **main process** WS server validates that envelope, buffers activity
 *     during the active meeting, and (after diarization) runs the PURE
 *     {@link CorrelateSpeakerNames} engine — parameterized by
 *     {@link SpeakerCorrelationParams} — to produce {@link SpeakerNameResolution}s;
 *   - the **renderer** reflects {@link SpeakerNamesStatus} (extension connected?
 *     names being captured?) so the user sees clear messaging either way.
 *
 * Lives in @loqui/shared (zod + emitted JSON Schema) so main, preload, renderer,
 * and the extension all type against ONE definition. @loqui/shared stays
 * zod-only — NO node deps here. This is a NEW, internal contract (it matches
 * nothing external), so it is kept minimal.
 *
 * #1 INVARIANT — GRACEFUL DEGRADATION. Every consumer treats this whole feature
 * as best-effort, untrusted, and optional: a missing/broken extension, a
 * selector miss, a malformed event, or zero activity MUST leave the meeting
 * completing with generic `Speaker N` labels and NO error. To make that the easy
 * path, every field below is defaulted so a partial/older payload parses forward
 * (mirroring the Meeting / CalendarEvent / DiarizedTranscript models), and the
 * correlation OUTPUT is explicitly allowed to be empty / low-confidence /
 * "leave it as Speaker N".
 *
 * CLOCK CONVENTION (documented once, reconciled everywhere): `ts` on a
 * {@link SpeakerActivityEvent} is **epoch milliseconds** (`Date.now()` in the
 * content script) — NOT seconds, and NOT relative to meeting start. The diarized
 * transcript's turns are in **seconds from meeting start** (see
 * {@link import("./postprocess.js").DiarizedSegment}). The correlation engine
 * reconciles the two by anchoring extension `ts` to the meeting's wall-clock
 * start (`startedAt`) and tolerating drift up to
 * {@link SpeakerCorrelationParams.skewToleranceMs}. Keeping `ts` as raw epoch ms
 * (rather than pre-subtracting a start the extension can't know) is deliberate:
 * the extension never needs to know the meeting clock; main owns reconciliation.
 */
import { z } from "zod";

// --- Loopback WS endpoint (extension <-> main) --------------------------------

/**
 * Host the main-process extension WS server binds to. LOOPBACK ONLY — never a
 * public host. The server binds exactly this host (so the OS refuses non-loopback
 * peers); tests assert the bound address is 127.0.0.1. The server also applies a
 * best-effort Origin gate (see {@link MEET_ORIGIN}) on the connection upgrade.
 */
export const SPEAKERNAMES_WS_HOST = "127.0.0.1" as const;

/**
 * Default loopback port the extension connects to. 0 would be OS-assigned, but
 * the extension (a separate process with no IPC) needs a STABLE port to dial, so
 * this is a fixed default the content script and the server agree on. Distinct
 * from the MCP HTTP port (7333) and the sidecar's dynamic port.
 */
export const SPEAKERNAMES_WS_DEFAULT_PORT = 7345 as const;

/** WS path the extension connects on (e.g. ws://127.0.0.1:7345/loqui-meet). */
export const SPEAKERNAMES_WS_PATH = "/loqui-meet" as const;

/**
 * The Meet origin the extension content script runs on. Pinned here so the WS
 * server can (best-effort) check the connecting Origin and the manifest host
 * permission stays in lockstep with one constant.
 */
export const MEET_ORIGIN = "https://meet.google.com" as const;

// --- The core activity event (extension -> main) ------------------------------

/**
 * One active-speaker observation read from Meet's UI by the content script: at
 * wall-clock `ts` (epoch ms — see the CLOCK CONVENTION above), participant
 * `name` was either speaking (`speaking: true`) or stopped speaking
 * (`speaking: false`). The extension emits these as the active-speaker indicator
 * toggles per participant; main buffers them for the active meeting and the
 * correlation engine overlaps their speaking intervals with diarized turns.
 *
 * `name` is the raw display name as Meet renders it (may include " (You)" /
 * presenter suffixes — normalization is the engine's job, not the wire's).
 * Defaulted so a partial event from an older/broken content script still parses
 * (and is then ignored as low-signal rather than throwing).
 */
export const speakerActivityEventSchema = z.object({
  /** Wall-clock epoch milliseconds (Date.now()) when the observation was made. */
  ts: z.number().default(0),
  /** Raw participant display name as read from Meet's DOM. */
  name: z.string().default(""),
  /** true = started/continues speaking; false = stopped speaking. */
  speaking: z.boolean().default(false),
});
export type SpeakerActivityEvent = z.infer<typeof speakerActivityEventSchema>;

// --- Extension WS message envelope (hello / activity / bye) -------------------

/** Discriminator values for the extension WS envelope. */
export const EXTENSION_MESSAGE_TYPES = ["hello", "activity", "bye"] as const;

/**
 * `hello` — the first frame the extension sends on connect. Identifies the
 * extension build + the Meet tab/session so main can associate it with the
 * CURRENT Loqui meeting (and ignore everything if no meeting is active). The
 * `meetingCode` is Meet's URL code (e.g. "abc-defg-hij") when the content script
 * can read it; null otherwise — association still works via "active meeting +
 * connected tab", the code is a best-effort correlation aid only.
 */
export const extensionHelloSchema = z.object({
  type: z.literal("hello"),
  /** Extension version string (manifest version), for logging/compat. */
  extensionVersion: z.string().default(""),
  /** Version of the swappable Meet-selector module that produced the events. */
  selectorVersion: z.string().default(""),
  /** Meet meeting code from the tab URL, or null when unreadable. */
  meetingCode: z.string().nullable().default(null),
  /** Origin the content script is running on (should be {@link MEET_ORIGIN}). */
  origin: z.string().default(""),
});
export type ExtensionHello = z.infer<typeof extensionHelloSchema>;

/**
 * `activity` — carries one {@link SpeakerActivityEvent}. The high-frequency
 * frame; main buffers its payload only while a meeting is active and drops it
 * otherwise (no active meeting => ignored, never an error).
 */
export const extensionActivitySchema = z.object({
  type: z.literal("activity"),
  event: speakerActivityEventSchema.default({}),
});
export type ExtensionActivity = z.infer<typeof extensionActivitySchema>;

/**
 * `bye` — sent when the content script tears down (Meet tab closed / call left).
 * Advisory only: main also handles a raw socket close identically. `reason` is a
 * short non-secret note for logs.
 */
export const extensionByeSchema = z.object({
  type: z.literal("bye"),
  reason: z.string().default(""),
});
export type ExtensionBye = z.infer<typeof extensionByeSchema>;

/**
 * The tagged union of every frame the extension may send. Main validates each
 * inbound frame against this; a frame that does not parse is DROPPED (logged,
 * never forwarded, never throws) — graceful degradation on the wire.
 */
export const extensionMessageSchema = z.discriminatedUnion("type", [
  extensionHelloSchema,
  extensionActivitySchema,
  extensionByeSchema,
]);
export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;

// --- Correlation engine parameters --------------------------------------------

/**
 * Default confidence threshold below which a resolved name is NOT applied (the
 * turn stays `Speaker N`). Conservative on purpose — a wrong name is worse than
 * a generic label.
 */
export const SPEAKERNAMES_DEFAULT_CONFIDENCE_THRESHOLD = 0.6 as const;

/**
 * Default clock-skew tolerance (ms) between the extension's wall clock and the
 * meeting clock when overlapping activity intervals with diarized turns.
 */
export const SPEAKERNAMES_DEFAULT_SKEW_TOLERANCE_MS = 1500 as const;

/**
 * Tuning for the PURE correlation engine. All defaulted so a bare call uses safe
 * values. `confidenceThreshold` gates whether a mapping is applied; `skewToleranceMs`
 * absorbs extension/meeting clock drift; `minOverlapMs` is the minimum
 * speaking/turn overlap to count as evidence (filters out incidental blips);
 * `meetingStartEpochMs` anchors extension epoch-ms `ts` to the diarized turns'
 * seconds-from-start axis (main passes the meeting's `startedAt` here).
 */
export const speakerCorrelationParamsSchema = z.object({
  confidenceThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(SPEAKERNAMES_DEFAULT_CONFIDENCE_THRESHOLD),
  skewToleranceMs: z
    .number()
    .nonnegative()
    .default(SPEAKERNAMES_DEFAULT_SKEW_TOLERANCE_MS),
  minOverlapMs: z.number().nonnegative().default(250),
  /** Epoch ms of meeting start; anchors `ts` to seconds-from-start. 0 = unknown. */
  meetingStartEpochMs: z.number().default(0),
});
export type SpeakerCorrelationParams = z.input<typeof speakerCorrelationParamsSchema>;

// --- Correlation output (Speaker N -> {name, confidence}) ---------------------

/**
 * One resolved mapping the engine emits: the stable diarized `speaker` label
 * (e.g. "Speaker 1") -> the best-matching participant `name`, with a `confidence`
 * in [0,1] and the `support` (how many ms of overlapping evidence backed it).
 * `apply` is the engine's verdict: true only when confidence >= the threshold
 * AND the mapping is unambiguous; ambiguous/low-confidence mappings carry
 * `apply: false` and the name-applier leaves that speaker as `Speaker N`.
 * "You" is never resolved here (mic is already known); the engine only maps the
 * system-stream `Speaker N` labels.
 */
export const speakerNameResolutionSchema = z.object({
  /** Stable diarized speaker label being resolved (e.g. "Speaker 1"). */
  speaker: z.string().default(""),
  /** Best-matching participant display name (normalized). Empty when unresolved. */
  name: z.string().default(""),
  /** Confidence in [0,1] that `speaker` is `name`. */
  confidence: z.number().min(0).max(1).default(0),
  /** Total overlapping evidence (ms) backing this mapping. */
  support: z.number().nonnegative().default(0),
  /** Engine verdict: apply this name (vs. leave the speaker as "Speaker N"). */
  apply: z.boolean().default(false),
});
export type SpeakerNameResolution = z.infer<typeof speakerNameResolutionSchema>;

/**
 * The full correlation result for one meeting. `resolutions` is one entry per
 * distinct system-stream speaker the engine considered (some with `apply:false`).
 * `participants` echoes the distinct names the extension reported (for the UI /
 * diagnostics). `usedActivityEvents`/`coveragePct` are diagnostics so the UI can
 * say "named 3 of 4 speakers". An EMPTY result (no extension, no activity) is
 * valid and means "apply nothing — keep generic labels".
 */
export const speakerCorrelationResultSchema = z.object({
  meetingId: z.string().default(""),
  resolutions: z.array(speakerNameResolutionSchema).default([]),
  /** Distinct participant names observed via the extension during the meeting. */
  participants: z.array(z.string()).default([]),
  /** How many activity events fed the correlation (0 => nothing to apply). */
  usedActivityEvents: z.number().int().nonnegative().default(0),
  /** Fraction [0,1] of system-stream turn time that got an applied name. */
  coveragePct: z.number().min(0).max(1).default(0),
});
export type SpeakerCorrelationResult = z.infer<typeof speakerCorrelationResultSchema>;

// --- Extension-connection status (main -> renderer) ---------------------------

/**
 * The extension/capture state surfaced to the renderer indicator. `disconnected`
 * = no extension socket; `connected` = socket open but not currently capturing
 * (e.g. no active meeting, or Meet tab idle); `capturing` = connected AND
 * receiving activity for the active meeting. The UI maps each to clear messaging,
 * always including that diarization still works without the extension.
 */
export const SPEAKERNAMES_CONN_STATES = [
  "disconnected",
  "connected",
  "capturing",
] as const;
export const speakerNamesConnStateSchema = z.enum(SPEAKERNAMES_CONN_STATES);
export type SpeakerNamesConnState = z.infer<typeof speakerNamesConnStateSchema>;

/**
 * Status shape pushed to the renderer (and returned by the `status()` invoke).
 * `state` is the high-level connection/capture state; `bufferedEvents` is how
 * many activity events are buffered for the active meeting (0 when none);
 * `lastEventAt` is the ISO-8601 time of the most recent activity (null if never);
 * `selectorVersion`/`extensionVersion` echo the connected extension's `hello`
 * (empty when disconnected); `meetingActive` is whether a Loqui meeting is
 * currently recording (events are only buffered when true). Every field
 * defaulted; the "nothing connected" status is the all-defaults value.
 */
export const speakerNamesStatusSchema = z.object({
  state: speakerNamesConnStateSchema.default("disconnected"),
  meetingActive: z.boolean().default(false),
  bufferedEvents: z.number().int().nonnegative().default(0),
  lastEventAt: z.string().datetime({ offset: true }).nullable().default(null),
  selectorVersion: z.string().default(""),
  extensionVersion: z.string().default(""),
});
export type SpeakerNamesStatus = z.infer<typeof speakerNamesStatusSchema>;
