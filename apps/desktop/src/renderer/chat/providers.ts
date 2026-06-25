/**
 * Provider presentation helpers (PRD-4 renderer): human labels for the
 * provider/model indicator + Settings dropdowns, and the in-call suggested
 * prompts. No logic, no IPC — pure presentation data so the ChatPanel and
 * ProviderSettings render a consistent vocabulary.
 */
import {
  AGENT_CLIS,
  ANTHROPIC_CHAT_MODELS,
  CHAT_PROVIDERS,
  type AgentCli,
  type AnthropicChatModel,
  type ChatProvider,
  type ProviderConfig,
} from "@loqui/shared";

/** Human label for each provider (Settings dropdown + active-provider badge). */
export const PROVIDER_LABEL: Record<ChatProvider, string> = {
  anthropic: "Anthropic (BYOK, cloud)",
  ollama: "Ollama (on-device)",
  "agent-cli": "Local agent CLI",
  native: "Apple on-device (no key)",
  mlx: "Bundled MLX (on-device)",
  fake: "Test provider",
};

/** Human label for each Anthropic chat model. */
export const ANTHROPIC_MODEL_LABEL: Record<AnthropicChatModel, string> = {
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
};

/** Human label for each local-agent CLI. */
export const AGENT_CLI_LABEL: Record<AgentCli, string> = {
  claude: "Claude Code (claude -p)",
  codex: "Codex (codex exec)",
};

/** Provider ids in display order (excludes `fake`, which is test-only). */
export const SELECTABLE_PROVIDERS: readonly ChatProvider[] = CHAT_PROVIDERS.filter(
  (p) => p !== "fake",
);

export const ANTHROPIC_MODELS: readonly AnthropicChatModel[] = ANTHROPIC_CHAT_MODELS;
export const SELECTABLE_AGENT_CLIS: readonly AgentCli[] = AGENT_CLIS;

/** Only the Anthropic BYOK provider needs a stored API key. */
export function providerNeedsApiKey(provider: ChatProvider): boolean {
  return provider === "anthropic";
}

/**
 * The model/identity string shown in the active-provider badge for a given
 * config — the concrete model (Anthropic), pulled model (Ollama), or CLI name.
 */
export function activeModelLabel(config: ProviderConfig): string {
  switch (config.provider) {
    case "anthropic":
      return ANTHROPIC_MODEL_LABEL[config.model as AnthropicChatModel] ?? config.model;
    case "ollama":
      return config.ollamaModel || "model";
    case "agent-cli":
      return AGENT_CLI_LABEL[config.cli] ?? config.cli;
    case "native":
      return "Apple Foundation Models";
    case "mlx":
      return config.nativeModel || "bundled model";
    case "fake":
      return "scripted";
    default:
      return config.model;
  }
}

/** Short provider+model summary for the badge, e.g. "Anthropic (BYOK) · Claude Opus 4.8". */
export function providerSummary(config: ProviderConfig): string {
  return `${PROVIDER_LABEL[config.provider]} · ${activeModelLabel(config)}`;
}

/**
 * The in-call suggested prompts (PRD-4 §"Chat UI"). One-tap starters that
 * ground the AI in the live transcript.
 */
export const SUGGESTED_PROMPTS: readonly string[] = [
  "What action items came up?",
  "Summarize the last 5 minutes",
  "What decisions were made?",
  "List any open questions",
];
