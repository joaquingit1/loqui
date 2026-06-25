/**
 * PRD-10 — shared on-device summary/chat provider + custom-prompt-template seams.
 *
 * The single source of truth for the cross-process shapes the provider/model
 * selector (spanning chat AND summaries) and the custom-template UI type against.
 * Kept in @loqui/shared (zod + emitted JSON Schema) so main, preload, the renderer
 * Settings UI, and — via the emitted JSON Schemas — the Python sidecar all agree
 * on ONE definition. @loqui/shared stays zod-only — NO node/electron deps here.
 *
 * This module is ADDITIVE on top of PRD-4's {@link import("./chat.js").ProviderConfig}
 * (chat.ts), which now also carries `nativeModel` + `summaryTemplate`. Here we add:
 *
 *   - {@link SummaryProvider} — the full provider id set (PRD-4's three + PRD-10's
 *     two zero-key on-device providers `native` + `mlx`). Used for the selector +
 *     the "fully on-device (no key)" vs "cloud (BYOK, higher quality)" distinction.
 *   - {@link SummaryProviderInfo} — one row of the availability/permission/download
 *     PROBE the Settings UI renders (mirror of {@link
 *     import("./transcription.js").TranscriptionEngineInfo}): whether THIS provider
 *     is available on this OS/arch, whether it needs a model download or a key/
 *     permission, its on-device-vs-cloud class, and a short note.
 *   - {@link SummaryPromptTemplate} + {@link DEFAULT_SUMMARY_TEMPLATES} — the named
 *     custom prompt slots (TL;DR / decisions / action-items + user-defined), with a
 *     `{transcript}` placeholder, used by PRD-5's summary job + offered in the UI.
 *
 * INVARIANT #4 (cross-platform — no provider choice ever breaks summaries): the
 * native providers are macOS-only; on Windows / unavailable they are absent/
 * disabled and the selector falls back to Ollama / BYOK / cloud. Switching takes
 * effect WITHOUT restart (chat is a live WS request; the summary uses the next
 * job's config — the sidecar selects the provider per request/job).
 *
 * INVARIANT #1 (the AI never edits the transcript): a custom template is a
 * READ-ONLY prompt knob. The `{transcript}` placeholder is filled from the
 * read-only transcript accessor in the sidecar; no template grants any write path.
 *
 * Every field is ADDITIVE + DEFAULTED so a partial payload / older config parses
 * forward (mirroring TranscriptionSettings / CaptureSettings / UpdaterSettings).
 */
import { z } from "zod";
import { CHAT_PROVIDERS } from "./chat.js";

// --- The full selectable provider set -----------------------------------------

/**
 * Every provider the chat/summaries selector can offer. Superset of PRD-4's
 * {@link import("./chat.js").CHAT_PROVIDERS}: it adds the two PRD-10 zero-key
 * on-device providers — `native` (Apple Foundation Models / NaturalLanguage via
 * the Swift helper) and `mlx` (bundled MLX small model). `fake` is the hermetic
 * test provider (hidden from the picker).
 */
export const SUMMARY_PROVIDERS = [
  "anthropic",
  "ollama",
  "agent-cli",
  "native",
  "mlx",
  "fake",
] as const;
export const summaryProviderSchema = z.enum(SUMMARY_PROVIDERS);
export type SummaryProvider = z.infer<typeof summaryProviderSchema>;

/**
 * The zero-key, fully-on-device providers (PRD-10). These run through the macOS
 * Swift helper and are gracefully absent on Windows — the selector falls back to
 * Ollama / BYOK / cloud. The "fully on-device (no key)" set the UI highlights.
 */
export const ONDEVICE_SUMMARY_PROVIDERS = ["native", "mlx"] as const;
export type OnDeviceSummaryProvider = (typeof ONDEVICE_SUMMARY_PROVIDERS)[number];

/** Providers that require a BYOK API key (cloud). Only `anthropic` today. */
export const KEY_REQUIRING_PROVIDERS = ["anthropic"] as const;

/**
 * The user-facing class of a provider, emitted for forward cross-process parity.
 * The live availability badge is not yet consumed (planned for the UI rehaul).
 *
 *   - `on-device` — zero key, runs locally (native, mlx, ollama).
 *   - `cloud` — BYOK, best quality (anthropic).
 *   - `local-cli` — a locally-installed agent CLI (agent-cli).
 *   - `test` — the hermetic fake provider.
 */
export const summaryProviderClassSchema = z.enum([
  "on-device",
  "cloud",
  "local-cli",
  "test",
]);
export type SummaryProviderClass = z.infer<typeof summaryProviderClassSchema>;

/** Pure classifier emitted for forward cross-process parity with provider metadata. */
export function summaryProviderClass(provider: SummaryProvider): SummaryProviderClass {
  if (provider === "native" || provider === "mlx" || provider === "ollama") {
    return "on-device";
  }
  if (provider === "anthropic") return "cloud";
  if (provider === "agent-cli") return "local-cli";
  return "test";
}

/** Whether a provider is a macOS-only on-device native provider (absent on Windows). */
export function isMacOnlySummaryProvider(provider: SummaryProvider): boolean {
  return provider === "native" || provider === "mlx";
}

/** Whether a provider needs a BYOK API key. */
export function summaryProviderNeedsKey(provider: SummaryProvider): boolean {
  return (KEY_REQUIRING_PROVIDERS as readonly string[]).includes(provider);
}

// Compile-time guard: every PRD-4 chat provider id is also a summary provider id
// (the summary set is a superset). Keeps the two enums from silently diverging.
type _AssertChatProvidersSubset =
  (typeof CHAT_PROVIDERS)[number] extends SummaryProvider ? true : never;
export const _summaryProvidersIncludeChatProviders: _AssertChatProvidersSubset = true;

// --- The availability / permission / download probe (Settings UI) -------------

/** Why a provider is or is not usable right now (drives the UI badge + note). */
export const summaryProviderAvailabilitySchema = z.enum([
  /** Ready to use now (cross-platform, or a present native engine). */
  "available",
  /** The OS/arch does not support this provider (a native provider on Windows). */
  "unsupported-os",
  /** Supported OS but the native helper/binary is not present (build/packaging). */
  "helper-missing",
  /** Needs a one-time permission grant (e.g. Apple Intelligence enablement). */
  "needs-permission",
  /** Needs a one-time model download before first use (bundled MLX). */
  "needs-download",
  /** Needs a BYOK API key (cloud) before use. */
  "needs-key",
  /** A local dependency is not installed (Ollama not running / CLI absent). */
  "needs-install",
]);
export type SummaryProviderAvailability = z.infer<
  typeof summaryProviderAvailabilitySchema
>;

/**
 * One row of provider availability metadata: the provider id, a display label,
 * its on-device/cloud class, whether it is macOS-only, whether it needs a key,
 * and its current availability + a short human note. Emitted for forward
 * cross-process parity; the live availability badge is not yet consumed
 * (planned for the UI rehaul).
 */
export const summaryProviderInfoSchema = z.object({
  provider: summaryProviderSchema,
  /** Human-facing label (e.g. "Apple on-device (no key)"). */
  label: z.string().default(""),
  /** "on-device" | "cloud" | "local-cli" | "test" — drives the UI grouping/badge. */
  providerClass: summaryProviderClassSchema.default("on-device"),
  /** macOS-only native providers are hidden/disabled on Windows. */
  macOnly: z.boolean().default(false),
  /** Whether this provider needs a BYOK API key (cloud). */
  needsKey: z.boolean().default(false),
  /** Whether the provider is available, and if not, why. */
  availability: summaryProviderAvailabilitySchema.default("available"),
  /** Short, human-readable note (never a secret). */
  note: z.string().default(""),
});
export type SummaryProviderInfo = z.infer<typeof summaryProviderInfoSchema>;

/**
 * The resolved runtime status shape: which provider was REQUESTED, which
 * actually served (== requested unless a fallback happened), and the
 * human-readable reason. Emitted for forward cross-process parity; the live
 * availability badge is not yet consumed (planned for the UI rehaul). Mirror of
 * {@link import("./transcription.js").TranscriptionStatus}.
 */
export const summaryProviderStatusSchema = z.object({
  requestedProvider: summaryProviderSchema.default("fake"),
  activeProvider: summaryProviderSchema.default("fake"),
  fellBack: z.boolean().default(false),
  reason: z.string().default(""),
});
export type SummaryProviderStatus = z.infer<typeof summaryProviderStatusSchema>;

// --- Custom summary prompt templates ------------------------------------------

/**
 * The placeholder a custom summary prompt template uses to mark where the
 * read-only transcript text is spliced in (mirror of the sidecar's
 * `TEMPLATE_PLACEHOLDER`). A template MAY omit it — in which case the sidecar
 * still prepends the read-only `<transcript>` context, so a template that just
 * says "Give me action items" still sees the transcript.
 */
export const SUMMARY_TEMPLATE_PLACEHOLDER = "{transcript}" as const;

/**
 * One named custom summary prompt slot. `id` is a stable key; `name` is the UI
 * label; `prompt` is the template text (with the optional {@link
 * SUMMARY_TEMPLATE_PLACEHOLDER}). `builtin` marks the shipped defaults (which the
 * UI may reset to but not delete). The chosen template's `prompt` is what gets
 * threaded into the postProcess summary request as `providerConfig.summaryTemplate`.
 */
export const summaryPromptTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  prompt: z.string().default(""),
  /** True for the shipped defaults (TL;DR / decisions / action-items). */
  builtin: z.boolean().default(false),
});
export type SummaryPromptTemplate = z.infer<typeof summaryPromptTemplateSchema>;

/**
 * The shipped default templates (the three named slots from the PRD: TL;DR /
 * decisions / action-items). The UI offers these out of the box; a user can pick
 * one, define their own, and regenerate with a different one. Each uses the
 * {@link SUMMARY_TEMPLATE_PLACEHOLDER} so the read-only transcript is spliced in.
 */
export const DEFAULT_SUMMARY_TEMPLATES: readonly SummaryPromptTemplate[] = [
  {
    id: "tldr",
    name: "TL;DR",
    builtin: true,
    prompt:
      "Give a concise 2-3 sentence TL;DR of this meeting. Use ONLY the " +
      "transcript as ground truth.\n\n" +
      SUMMARY_TEMPLATE_PLACEHOLDER,
  },
  {
    id: "decisions",
    name: "Key decisions",
    builtin: true,
    prompt:
      "List the key decisions made in this meeting as bullet points. Use ONLY " +
      "the transcript.\n\n" +
      SUMMARY_TEMPLATE_PLACEHOLDER,
  },
  {
    id: "action-items",
    name: "Action items",
    builtin: true,
    prompt:
      "Extract the action items from this meeting, naming the owner when one is " +
      "clearly stated. Use ONLY the transcript.\n\n" +
      SUMMARY_TEMPLATE_PLACEHOLDER,
  },
];

/**
 * Summary-template settings shape for future persistence. All additive +
 * defaulted so an older config loads forward to the built-in defaults —
 * byte-identical to today's behavior (no template selected => the built-in
 * SUMMARY_INSTRUCTION). Emitted for forward cross-process parity; template-
 * settings persistence is not yet consumed (planned for the UI rehaul).
 */
export const summaryTemplateSettingsSchema = z.object({
  /** The available templates (defaults + any user-defined). */
  templates: z.array(summaryPromptTemplateSchema).default([...DEFAULT_SUMMARY_TEMPLATES]),
  /**
   * The currently-selected template id, or null for "no custom template" (the
   * built-in structured-summary instruction). Default null preserves the PRD-5
   * default summary behavior.
   */
  selectedId: z.string().nullable().default(null),
});
export type SummaryTemplateSettings = z.infer<typeof summaryTemplateSettingsSchema>;

/**
 * Patch shape for future summary-template settings persistence. Emitted for
 * forward cross-process parity; template-settings persistence is not yet
 * consumed (planned for the UI rehaul).
 */
export const updateSummaryTemplateSettingsSchema = summaryTemplateSettingsSchema.partial();
export type UpdateSummaryTemplateSettings = z.infer<
  typeof updateSummaryTemplateSettingsSchema
>;

/**
 * Pure resolver: given the template settings, return the selected template's
 * prompt text (or "" when none is selected / the id is unknown). Emitted for
 * forward cross-process parity; template-settings persistence is not yet
 * consumed (planned for the UI rehaul).
 */
export function resolveSelectedTemplatePrompt(
  settings: SummaryTemplateSettings,
): string {
  if (!settings.selectedId) return "";
  const found = settings.templates.find((t) => t.id === settings.selectedId);
  return found?.prompt ?? "";
}
