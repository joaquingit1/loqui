/**
 * PRD-11 — shared auto-record + menubar/tray contract seams.
 *
 * The single source of truth for the cross-process shapes the auto-record /
 * tray feature types against (main owns the detection + lifecycle; the renderer
 * + tray reflect state; the PRD-6 extension feeds the browser in-call signal):
 *
 *   - {@link AutoRecordSettings} — the persisted, additive + defaulted policy
 *     (off by DEFAULT so the baseline stays manual-only PRD-3 behavior) read by
 *     the settings store, the detection engine, and the Settings UI.
 *   - {@link DetectionInputs} / {@link DetectionDecision} — the inputs/outputs of
 *     the PURE, platform-agnostic decision core (the heart of detection). Kept
 *     here so the engine, the core, and the tests all type against ONE shape.
 *   - {@link AutoRecordState} — the runtime status surfaced to the renderer + the
 *     tray indicator (recording? auto vs manual? counting down to a silence stop?).
 *   - {@link BrowserCallState} — the "a browser tab is in a call" signal the PRD-6
 *     extension relays over the EXISTING loopback WS (no new socket).
 *
 * Lives in @loqui/shared (zod + emitted JSON Schema) so main, preload, renderer,
 * the tray, and the extension all type against ONE definition. @loqui/shared
 * stays zod-only — NO node/electron deps here. Every field is ADDITIVE +
 * DEFAULTED so an older `app-settings.json` (or a partial payload) parses forward
 * (mirroring CaptureSettings / Meeting / SpeakerNamesStatus).
 *
 * #1 POSTURE — MANUAL-FIRST: auto-record is OFF by default. With it off the app
 * behaves EXACTLY like PRD-3 (manual start/stop); nothing here ever blocks a
 * manual start or stop. Detection is best-effort: a probe that is unavailable or
 * throws yields "no signal", never a crash and never a missed manual control.
 */
import { z } from "zod";

// --- The configurable native-app allowlist ------------------------------------

/**
 * Default conferencing apps whose running-process + active-mic presence triggers
 * native auto-record (matched case-insensitively against the OS process/app
 * names by the platform probe). Mirrors the comparable local app's set plus
 * Loqui's browser coverage via the PRD-6 extension. Configurable — the user may
 * override the list in settings; this is only the default.
 */
export const DEFAULT_NATIVE_APP_ALLOWLIST = [
  "zoom",
  "teams",
  "slack",
  "facetime",
  "webex",
  "discord",
  "meet",
  "loom",
] as const;

// --- Auto-record policy (persisted, additive + defaulted) ---------------------

/**
 * What to do the moment a meeting is DETECTED:
 *   - `auto` — start recording immediately (per the comparable local app's UX).
 *   - `ask`  — surface a prompt and let the user confirm (the engine emits a
 *     `pendingStart` state; the renderer shows the prompt; an explicit accept
 *     calls the normal start path). Conservative for first-run.
 */
export const autoRecordOnDetectSchema = z.enum(["auto", "ask"]).default("ask");
export type AutoRecordOnDetect = z.infer<typeof autoRecordOnDetectSchema>;

/**
 * The persisted auto-record + tray policy (`<dataRoot>/app-settings.json` under
 * the `autoRecord` key). All additive + defaulted so an older config (and the
 * privacy-preserving baseline) loads forward as MANUAL-ONLY.
 *
 * Defaults are chosen so the out-of-the-box behavior is byte-identical to PRD-3:
 * `enabled:false` => the engine makes NO decisions and never auto-starts/stops.
 */
export const autoRecordSettingsSchema = z.object({
  /**
   * Master switch. OFF BY DEFAULT — the app is manual-only (PRD-3) until the
   * user opts in. When false the detection engine is inert: it polls nothing and
   * emits no start/stop decisions; manual start/stop is unaffected.
   */
  enabled: z.boolean().default(false),
  /** On detection: prompt (`ask`, default) or start immediately (`auto`). */
  onDetect: autoRecordOnDetectSchema,
  /**
   * Whether to detect NATIVE conferencing apps (process + active mic). Default
   * on (when auto-record is enabled). Best-effort + OS-gated; a no-op where the
   * native probe is unavailable.
   */
  detectNativeApps: z.boolean().default(true),
  /**
   * Whether to detect BROWSER meetings via the PRD-6 extension in-call signal.
   * Default on (when auto-record is enabled). Independent of native detection.
   */
  detectBrowserMeetings: z.boolean().default(true),
  /**
   * Case-insensitive substrings matched against the OS process/app names to
   * decide a conferencing app is running. Defaults to
   * {@link DEFAULT_NATIVE_APP_ALLOWLIST}; the user may customize it.
   */
  appAllowlist: z.array(z.string()).default([...DEFAULT_NATIVE_APP_ALLOWLIST]),
  /**
   * Delay (ms) after a meeting ENDS (all signals clear) before auto-stopping.
   * Mirrors the comparable local app's ~5 s grace so a brief blip doesn't end a
   * meeting prematurely. Default 5000.
   */
  autoStopDelayMs: z.number().int().nonnegative().default(5000),
  /**
   * Silence auto-stop: end an active recording after this many ms with NO
   * speech/audio activity (a visible countdown precedes it). 0 disables the
   * silence stop. Default 0 (off) so it's an explicit opt-in.
   */
  silenceTimeoutMs: z.number().int().nonnegative().default(0),
  /**
   * How long (ms) before the silence stop fires to begin SHOWING the countdown
   * in the UI/tray. Default 30000 (last 30 s). Clamped to `silenceTimeoutMs`.
   */
  silenceCountdownMs: z.number().int().nonnegative().default(30000),
  /**
   * Run in the background (no dock icon on macOS) so the app lives in the tray.
   * Default false — the main window stays the primary surface unless opted in.
   */
  runInBackground: z.boolean().default(false),
  /** Launch Loqui at login (via `app.setLoginItemSettings`). Default false. */
  launchAtLogin: z.boolean().default(false),
});
export type AutoRecordSettings = z.infer<typeof autoRecordSettingsSchema>;

/** Patch accepted by `setAutoRecordSettings` — any subset of the fields. */
export const updateAutoRecordSettingsSchema = autoRecordSettingsSchema.partial();
export type UpdateAutoRecordSettings = z.infer<typeof updateAutoRecordSettingsSchema>;

// --- The PURE decision-core inputs --------------------------------------------

/**
 * The reason a meeting is considered present, for diagnostics + the UI ("started
 * because Zoom is in a call"). `none` = no signal.
 */
export const detectionSourceSchema = z
  .enum(["none", "native-app", "browser"])
  .default("none");
export type DetectionSource = z.infer<typeof detectionSourceSchema>;

/**
 * The instantaneous, platform-AGNOSTIC inputs to the decision core. Produced by
 * the engine each tick from the injectable probes + the clock; the core is a
 * pure function of these (plus its prior state) so it is exhaustively unit
 * testable via a truth table. NONE of these fields require any OS access — the
 * engine resolves them and hands the core booleans.
 */
export const detectionInputsSchema = z.object({
  /** A native conferencing app from the allowlist is running. */
  nativeAppActive: z.boolean().default(false),
  /** The microphone/audio is actively in use (native call is "live"). */
  micActive: z.boolean().default(false),
  /** A browser tab reports being in a call (PRD-6 extension in-call signal). */
  browserInCall: z.boolean().default(false),
  /** Whether a Loqui meeting is already recording (manual OR auto). */
  recording: z.boolean().default(false),
  /**
   * Whether the active recording was started by auto-record (vs manually). The
   * core NEVER auto-stops a MANUALLY started meeting — manual control is
   * sacrosanct; only auto-started meetings auto-stop on signal loss.
   */
  autoStarted: z.boolean().default(false),
  /** Monotonic-ish wall clock (epoch ms) for the timers. */
  now: z.number().default(0),
});
export type DetectionInputs = z.infer<typeof detectionInputsSchema>;

// --- The PURE decision-core output --------------------------------------------

/**
 * The decision-core verdict for one tick:
 *   - `none`         — do nothing.
 *   - `start`        — start recording now (policy `auto`, or an accepted prompt).
 *   - `prompt-start` — a meeting is detected but policy is `ask`; the engine
 *     surfaces a prompt and waits (it does NOT start until the user accepts).
 *   - `stop`         — stop the (auto-started) recording now (signals cleared past
 *     the grace delay, or the silence timeout elapsed).
 * `source` explains a start; `reason` is a short human/diagnostic note.
 */
export const detectionActionSchema = z.enum([
  "none",
  "start",
  "prompt-start",
  "stop",
]);
export type DetectionAction = z.infer<typeof detectionActionSchema>;

export const detectionDecisionSchema = z.object({
  action: detectionActionSchema.default("none"),
  source: detectionSourceSchema,
  /** Short non-secret diagnostic note (e.g. "native call active", "silence 60s"). */
  reason: z.string().default(""),
});
export type DetectionDecision = z.infer<typeof detectionDecisionSchema>;

// --- The runtime auto-record state (main -> renderer + tray) ------------------

/**
 * The high-level auto-record runtime phase surfaced to the renderer + tray:
 *   - `disabled`     — auto-record is off (manual-only).
 *   - `idle`         — enabled, watching, nothing detected.
 *   - `detected`     — a meeting is detected; policy `ask` is awaiting the user.
 *   - `recording`    — a recording is in progress (auto or manual).
 *   - `countdown`    — recording + a silence auto-stop is imminent (show countdown).
 */
export const autoRecordPhaseSchema = z
  .enum(["disabled", "idle", "detected", "recording", "countdown"])
  .default("disabled");
export type AutoRecordPhase = z.infer<typeof autoRecordPhaseSchema>;

/**
 * The auto-record runtime state pushed to the renderer (and returned by the
 * status invoke) + read by the tray for the icon/menu. Every field defaulted;
 * the "off" state is the all-defaults value.
 */
export const autoRecordStateSchema = z.object({
  /** Whether auto-record is enabled (master switch). */
  enabled: z.boolean().default(false),
  /** The high-level phase (drives the tray icon + window badge). */
  phase: autoRecordPhaseSchema,
  /** Whether a recording is currently in progress (auto OR manual). */
  recording: z.boolean().default(false),
  /** Whether the in-progress recording was started by auto-record. */
  autoStarted: z.boolean().default(false),
  /** Why the current/last detection fired (for the UI). */
  source: detectionSourceSchema,
  /** Latest resolved detection inputs (for the Settings diagnostics panel). */
  nativeAppActive: z.boolean().default(false),
  micActive: z.boolean().default(false),
  browserInCall: z.boolean().default(false),
  /**
   * Seconds remaining on a silence auto-stop countdown, or null when not
   * counting down. The UI/tray render this as a visible countdown.
   */
  silenceCountdownSec: z.number().int().nonnegative().nullable().default(null),
});
export type AutoRecordState = z.infer<typeof autoRecordStateSchema>;

// --- The browser in-call signal (PRD-6 extension -> main, EXISTING WS) ---------

/**
 * The "is a browser tab in a call?" view derived from the PRD-6 extension's
 * activity over the EXISTING loopback WS (no new socket). The extension already
 * connects + streams activity while a Meet tab is in a call; the WS server
 * surfaces this collapsed boolean to the auto-record engine. `lastSeenAt` is the
 * ISO time of the most recent in-call signal (for staleness), null when never.
 */
export const browserCallStateSchema = z.object({
  inCall: z.boolean().default(false),
  lastSeenAt: z.string().datetime({ offset: true }).nullable().default(null),
});
export type BrowserCallState = z.infer<typeof browserCallStateSchema>;
