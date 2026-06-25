/**
 * PRD-4 shared AI-chat contract: the chat message + provider config + chat
 * event shapes, defined ONCE so the renderer chat panel, preload bridge, main
 * IPC handlers, and (via the emitted JSON Schema) the Python sidecar provider
 * layer all type against a single source.
 *
 * Architecture (read-only over the transcript — the AI NEVER edits it):
 *
 *   renderer chat panel
 *     -> IPC `chat:send` {meetingId, messages, providerConfig} to main
 *     -> main reads the API key from the OS keychain (Electron safeStorage) and
 *        forwards a `chat` request over the existing token-authed loopback WS to
 *        the sidecar (providerConfig + transient apiKey)
 *     -> sidecar reads the meeting transcript READ-ONLY, builds context, calls
 *        the selected ChatProvider, and STREAMS tokens back as `chatToken` WS
 *        notifications, then `chatDone` (or `chatError`)
 *     -> main forwards to renderer -> the chat UI renders the stream.
 *
 * CROSS-CUTTING INVARIANT: there is NO field/IPC/WS path in this contract by
 * which a provider or the chat handler can write/patch a transcript or meta
 * file. The chat layer receives the transcript as READ-ONLY input context.
 *
 * Producers/consumers live in the Build phase; this module defines TYPES + zod
 * schemas only (mirroring ./events.ts and ./library.ts).
 */
import { z } from "zod";

/**
 * The AI providers the chat/summaries layer can be configured with (PRD-4 §
 * "Providers"). All three are pluggable behind the sidecar `ChatProvider`
 * protocol; `fake` is the deterministic, hermetic provider used by the unit
 * gate + smoke (no network, no key, no CLI).
 *
 * - `anthropic` — BYOK; official `anthropic` Python SDK; streaming + adaptive
 *   thinking. Key supplied per-request from the OS keychain; never persisted by
 *   the sidecar.
 * - `ollama` — local OpenAI-compatible / native endpoint (default
 *   `http://localhost:11434`); fully offline; user picks a pulled model.
 * - `agent-cli` — a locally-installed Claude Code (`claude -p`) or Codex
 *   (`codex exec`) headless CLI invoked via subprocess; availability detected at
 *   runtime.
 * - `native` — PRD-10 zero-key, on-device Apple provider (Foundation Models /
 *   NaturalLanguage via the macOS Swift helper). macOS-only; the selector falls
 *   back to Ollama/BYOK/cloud on Windows / when unavailable.
 * - `mlx` — PRD-10 bundled MLX small model (Apple Silicon; first-run fetch then
 *   offline). macOS-only; same fallback as `native`.
 * - `fake` — scripted token stream for tests/smoke.
 *
 * See {@link import("./summaryprovider.js").SUMMARY_PROVIDERS} for the same set
 * plus the on-device/cloud classification + availability the selector UI renders.
 */
export const CHAT_PROVIDERS = [
  "anthropic",
  "ollama",
  "agent-cli",
  "native",
  "mlx",
  "fake",
] as const;
export const chatProviderSchema = z.enum(CHAT_PROVIDERS);
export type ChatProvider = z.infer<typeof chatProviderSchema>;

/**
 * The Anthropic chat models the BYOK provider may select. Default is
 * `claude-opus-4-8` (per the PRD contract). The sidecar passes the chosen id
 * straight to the official SDK's `messages.stream(model=...)`.
 */
export const ANTHROPIC_CHAT_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;
export const anthropicChatModelSchema = z.enum(ANTHROPIC_CHAT_MODELS);
export type AnthropicChatModel = z.infer<typeof anthropicChatModelSchema>;

/** Default Anthropic chat model (configurable; see {@link ANTHROPIC_CHAT_MODELS}). */
export const DEFAULT_ANTHROPIC_CHAT_MODEL: AnthropicChatModel = "claude-opus-4-8";

/** Default Ollama base URL (configurable). */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434" as const;

/** Default local-agent CLI to invoke when {@link ProviderConfig.provider} is `agent-cli`. */
export const AGENT_CLIS = ["claude", "codex"] as const;
export const agentCliSchema = z.enum(AGENT_CLIS);
export type AgentCli = z.infer<typeof agentCliSchema>;

/**
 * The role of one chat message. `system` is reserved for the handler-built
 * grounding/instruction context; the renderer sends `user` turns and renders
 * `assistant` replies. Mirrors the provider message roles.
 */
export const chatRoleSchema = z.enum(["system", "user", "assistant"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

/**
 * One chat message in a conversation. The renderer maintains per-meeting
 * history as `ChatMessage[]` and sends it (sans any system context, which the
 * sidecar handler injects from the read-only transcript) on each turn.
 */
export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.string().default(""),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Non-secret provider selection + tuning, persisted in app settings and sent on
 * every `chat:send`. The API key is NEVER part of this object — it lives in the
 * OS keychain and is injected by main into the WS request out of band, so the
 * persisted/logged provider settings can never carry a secret.
 *
 * NOTE (per the Anthropic contract): the sidecar BYOK provider does NOT send
 * temperature/top_p/top_k or budget_tokens (they 400 on Opus 4.8 / Sonnet 4.6);
 * those knobs are deliberately absent here. `model`/`baseUrl`/`cli` are the only
 * provider-specific tuning the renderer surfaces.
 */
export const providerConfigSchema = z.object({
  provider: chatProviderSchema.default("fake"),
  /** Anthropic model id (only meaningful for `provider: "anthropic"`). */
  model: z.string().default(DEFAULT_ANTHROPIC_CHAT_MODEL),
  /** Ollama base URL (only meaningful for `provider: "ollama"`). */
  baseUrl: z.string().default(DEFAULT_OLLAMA_BASE_URL),
  /** Ollama model name (a pulled model; only meaningful for `provider: "ollama"`). */
  ollamaModel: z.string().default("llama3.1"),
  /** Which local agent CLI to invoke (only meaningful for `provider: "agent-cli"`). */
  cli: agentCliSchema.default("claude"),
  /**
   * PRD-10 — on-device model id for `provider: "mlx"` (the bundled MLX model id;
   * empty => the helper's default). Ignored by the Apple-native provider (no
   * selectable model) and the other providers. Additive + defaulted "".
   */
  nativeModel: z.string().default(""),
  /**
   * PRD-10 — the chosen custom summary prompt-template TEXT (with the optional
   * {@link import("./summaryprovider.js").SUMMARY_TEMPLATE_PLACEHOLDER}). When
   * non-empty, PRD-5's summary job uses it INSTEAD of the built-in structured-
   * summary instruction so a user can pick TL;DR / decisions / action-items (or
   * their own) and regenerate with a different one. Empty => the default summary
   * behavior (byte-identical to pre-PRD-10). READ-ONLY prompt knob: it never
   * grants a write path — the AI still never edits the transcript. Carried on
   * `providerConfig` (not a new top-level field) so it flows through BOTH the chat
   * and the postProcess paths that already ship a `providerConfig`.
   */
  summaryTemplate: z.string().default(""),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * The chat-send payload the renderer hands main on {@link IPC.chatSend}. `chatId`
 * correlates the streamed `chatToken`/`chatDone`/`chatError` events back to the
 * originating send (so multiple in-flight chats — or a re-mounted panel — never
 * cross streams). The renderer mints it (a UUID).
 *
 * `messages` is the conversation history WITHOUT transcript context — the
 * sidecar handler reads the transcript READ-ONLY and builds the grounding
 * context itself, so the renderer never has to ship (and cannot tamper with)
 * the transcript on the way to the provider.
 */
export const chatSendParamsSchema = z.object({
  chatId: z.string().min(1),
  meetingId: z.string(),
  messages: z.array(chatMessageSchema).default([]),
  providerConfig: providerConfigSchema.default({}),
});
export type ChatSendParams = z.infer<typeof chatSendParamsSchema>;

// --- WS chat request (main -> sidecar) ---------------------------------------

/**
 * The WS notification `event` names for the chat protocol. The chat REQUEST
 * rides as a `notification` (main -> sidecar) on the existing per-connection
 * sender — NOT a `WsRequest` (those are the fixed ping/getHealth/shutdown enum)
 * — so the additive chat path does not touch the PRD-0 request contract. The
 * streamed RESPONSE rides as `notification`s (sidecar -> main).
 */
export const CHAT_EVENT = {
  /** main -> sidecar: begin streaming a chat completion. */
  request: "chatRequest",
  /** sidecar -> main: one streamed token/text delta. */
  token: "chatToken",
  /** sidecar -> main: stream finished successfully. */
  done: "chatDone",
  /** sidecar -> main: stream failed (actionable error). */
  error: "chatError",
} as const;

export const CHAT_REQUEST_EVENT = CHAT_EVENT.request;
export const CHAT_TOKEN_EVENT = CHAT_EVENT.token;
export const CHAT_DONE_EVENT = CHAT_EVENT.done;
export const CHAT_ERROR_EVENT = CHAT_EVENT.error;

/**
 * The `chatRequest` notification `data` (main -> sidecar). Carries the
 * provider config + conversation + the TRANSIENT api key main pulled from the
 * keychain. The sidecar uses `apiKey` only for the duration of the request and
 * NEVER persists or logs it (the Anthropic SDK client is constructed with it
 * per-request).
 *
 * The sidecar resolves the transcript itself from `meetingId` via its read-only
 * accessor — the transcript text is NOT part of this payload.
 */
export const chatRequestSchema = z.object({
  chatId: z.string().min(1),
  meetingId: z.string(),
  messages: z.array(chatMessageSchema).default([]),
  providerConfig: providerConfigSchema.default({}),
  /**
   * BYOK secret, injected by main from the OS keychain; transient. Optional /
   * nullable because local providers (`ollama`, `agent-cli`, `fake`) need no
   * key. The sidecar never writes this to disk or logs.
   */
  apiKey: z.string().nullable().default(null).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

// --- WS chat notifications (sidecar -> main) ---------------------------------

/**
 * One streamed token/text delta. `chatId` correlates back to the originating
 * `chatRequest`/`chat:send`. `delta` is the incremental text to append to the
 * rendered assistant message.
 */
export const chatTokenSchema = z.object({
  chatId: z.string().min(1),
  delta: z.string().default(""),
});
export type ChatToken = z.infer<typeof chatTokenSchema>;

/**
 * Terminal "stream finished OK" notification. `text` is the full assembled
 * assistant message (so a late-attaching renderer can reconcile), and
 * `model`/`provider` echo what actually served the response (for the active-
 * provider indicator).
 */
export const chatDoneSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().default(""),
  provider: chatProviderSchema.optional(),
  model: z.string().optional(),
});
export type ChatDone = z.infer<typeof chatDoneSchema>;

/** Stable, machine-readable chat error codes (mirror of the sidecar's). */
export const CHAT_ERROR_CODES = [
  /** A required API key was missing/empty for a key-requiring provider. */
  "missing_api_key",
  /** The provider rejected auth (e.g. Anthropic 401/403). */
  "auth_error",
  /** Ollama unreachable at the configured base URL. */
  "ollama_unreachable",
  /** The selected agent CLI is not installed / not on PATH. */
  "cli_not_found",
  /** The agent CLI exited non-zero / produced unusable output. */
  "cli_error",
  /** The provider/model rejected the request (e.g. 400). */
  "provider_error",
  /** The requested meeting / transcript does not exist. */
  "meeting_not_found",
  /** Anything else. */
  "internal_error",
] as const;
export const chatErrorCodeSchema = z.enum(CHAT_ERROR_CODES);
export type ChatErrorCode = z.infer<typeof chatErrorCodeSchema>;

/**
 * Terminal "stream failed" notification. `message` is a human-readable,
 * actionable explanation (e.g. "Ollama is not running at http://localhost:11434"
 * or "Claude Code CLI not found — install it or pick another provider"). NEVER
 * carries the api key.
 */
export const chatErrorSchema = z.object({
  chatId: z.string().min(1),
  code: chatErrorCodeSchema.default("internal_error"),
  message: z.string().default(""),
});
export type ChatError = z.infer<typeof chatErrorSchema>;

/**
 * The renderer-facing union pushed on the chat stream IPC channel. main forwards
 * each sidecar chat notification as one of these tagged events so the chat panel
 * has a single subscription that drives token/done/error rendering.
 */
export type ChatStreamEvent =
  | ({ kind: "token" } & ChatToken)
  | ({ kind: "done" } & ChatDone)
  | ({ kind: "error" } & ChatError);

// --- safeStorage key API (renderer-facing, via preload) ----------------------

/** Params to store/clear a provider's BYOK key in the OS keychain. */
export const setApiKeyParamsSchema = z.object({
  /** Which provider the key belongs to (only `anthropic` uses one today). */
  provider: chatProviderSchema.default("anthropic"),
  /**
   * The plaintext key to encrypt + persist via Electron `safeStorage`. Pass an
   * empty string (or `null`) to CLEAR the stored key. Never logged.
   */
  apiKey: z.string().nullable().default(null),
});
export type SetApiKeyParams = z.infer<typeof setApiKeyParamsSchema>;

/** Whether a BYOK key is currently stored for a provider (never returns the key). */
export const apiKeyStatusSchema = z.object({
  provider: chatProviderSchema.default("anthropic"),
  hasKey: z.boolean().default(false),
});
export type ApiKeyStatus = z.infer<typeof apiKeyStatusSchema>;
