/**
 * Barrel for the PRD-4 renderer chat module: the pure conversation model, the
 * streaming hook, and the provider presentation helpers. The components import
 * from here so the public surface of the module is explicit.
 */
export {
  applyStreamEvent,
  emptyChatState,
  startTurn,
  type ChatState,
  type ChatTurn,
} from "./model.js";
export { useChat, type UseChatOptions, type UseChatResult } from "./useChat.js";
export {
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_LABEL,
  AGENT_CLI_LABEL,
  PROVIDER_LABEL,
  SELECTABLE_AGENT_CLIS,
  SELECTABLE_PROVIDERS,
  SUGGESTED_PROMPTS,
  activeModelLabel,
  providerNeedsApiKey,
  providerSummary,
} from "./providers.js";
