"""AI chat-provider abstraction (PRD-4) — Foundation contract package.

This package defines the SEAMS the three provider build units implement against;
it ships the wiring + interfaces + the hermetic FAKE provider + the READ-ONLY
transcript accessor, NOT the Anthropic/Ollama/agent-CLI logic. The build units
fill in:

* ``anthropic_provider`` — the BYOK :class:`ChatProvider` over the official
  ``anthropic`` SDK (streaming + adaptive thinking; no sampling params).
* ``ollama_provider`` — the local OpenAI-compatible / native :class:`ChatProvider`
  over ``httpx`` to ``http://localhost:11434``.
* ``agent_cli_provider`` — the subprocess :class:`ChatProvider` over an installed
  ``claude`` / ``codex`` CLI in headless mode.
* the renderer chat panel (apps/desktop) — consumes the streamed events.

The provider layer lives in the sidecar (not main) so PRD-5 summaries can reuse
:class:`ChatProvider` with no special-casing.

CROSS-CUTTING INVARIANT: **the AI never edits the transcript.** Providers receive
the conversation + a READ-ONLY context string built from
:class:`FsTranscriptReader`; nothing in this package can write a transcript/meta
file. See :mod:`loqui_sidecar.providers.types` for the boundary.
"""

from __future__ import annotations

from .types import (
    ANTHROPIC_CHAT_MODELS,
    CHAT_DONE_EVENT,
    CHAT_ERROR_CODES,
    CHAT_ERROR_EVENT,
    CHAT_REQUEST_EVENT,
    CHAT_TOKEN_EVENT,
    DEFAULT_ANTHROPIC_CHAT_MODEL,
    DEFAULT_CHAT_MAX_TOKENS,
    DEFAULT_OLLAMA_BASE_URL,
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    ChatRequest,
    ChatResult,
    ProviderConfig,
    TranscriptReader,
)
from .transcript import (
    FsTranscriptReader,
    default_transcript_reader,
    meeting_transcript_path,
)
from .fake import FAKE_CHAT_ENV, FakeChatProvider, fake_chat_enabled
from .handler import (
    CONTEXT_CHAR_BUDGET,
    ChatEmit,
    ProviderSelector,
    build_context_message,
    handle_chat,
    make_provider_selector,
)

# --- Real provider build units (PRD-4) ----------------------------------------
# These are import-light: each implementation lazy-imports its heavy/optional
# dependency (anthropic / httpx) only when a provider is actually constructed and
# used, so importing the package stays hermetic for the fake-provider unit gate.
from .anthropic_provider import (
    ADAPTIVE_THINKING,
    AnthropicProvider,
    anthropic_factory,
)
from .ollama_provider import OllamaProvider, ollama_factory
from .agent_cli_provider import AgentCliProvider, agent_cli_factory, render_prompt
from .native_provider import (
    BundledMlxProvider,
    NativeChatProvider,
    mlx_factory,
    native_factory,
    probe_summary_capabilities,
)
from .registry import build_selector, default_selector

__all__ = [
    # event names
    "CHAT_REQUEST_EVENT",
    "CHAT_TOKEN_EVENT",
    "CHAT_DONE_EVENT",
    "CHAT_ERROR_EVENT",
    "CHAT_ERROR_CODES",
    # model/provider constants
    "ANTHROPIC_CHAT_MODELS",
    "DEFAULT_ANTHROPIC_CHAT_MODEL",
    "DEFAULT_CHAT_MAX_TOKENS",
    "DEFAULT_OLLAMA_BASE_URL",
    # contract types
    "ChatMessage",
    "ProviderConfig",
    "ChatRequest",
    "ChatResult",
    "ChatProvider",
    "ChatProviderError",
    "TranscriptReader",
    # read-only transcript accessor
    "FsTranscriptReader",
    "default_transcript_reader",
    "meeting_transcript_path",
    # fake provider
    "FakeChatProvider",
    "fake_chat_enabled",
    "FAKE_CHAT_ENV",
    # handler
    "ChatEmit",
    "ProviderSelector",
    "handle_chat",
    "build_context_message",
    "make_provider_selector",
    "CONTEXT_CHAR_BUDGET",
    # real provider build units
    "AnthropicProvider",
    "anthropic_factory",
    "ADAPTIVE_THINKING",
    "OllamaProvider",
    "ollama_factory",
    "AgentCliProvider",
    "agent_cli_factory",
    "render_prompt",
    # on-device providers (PRD-10)
    "NativeChatProvider",
    "BundledMlxProvider",
    "native_factory",
    "mlx_factory",
    "probe_summary_capabilities",
    "build_selector",
    "default_selector",
]
