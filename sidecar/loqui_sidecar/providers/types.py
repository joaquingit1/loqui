"""Chat-provider contract types (PRD-4) — the precise interfaces the three
provider build units implement against.

Nothing here does work — these are the *shapes* and *protocols*. Keeping them in
one module (no ``anthropic`` / ``httpx`` import) means the chat handler, the fake
provider, and the tests can import the contract without pulling a heavy or
optional dependency.

CROSS-CUTTING INVARIANT (the headline of PRD-4): **the AI never edits the
transcript.** A :class:`ChatProvider` receives the conversation + a READ-ONLY
``context`` string (built by the handler from the read-only transcript accessor)
and yields output tokens. It is handed NO writer, NO store, and NO file handle —
structurally it cannot mutate ``transcript.live.md`` / the diarized variants /
``meta.json``. The provider build units MUST NOT import the store/TranscriptWriter
or open any meeting file for writing.

Wire contract (mirror of ``@loqui/shared`` ``ChatMessage`` / ``ChatToken`` /
``ChatDone`` / ``ChatError`` — ``packages/shared/src/chat.ts``)::

    ChatMessage   { role: "system"|"user"|"assistant", content: str }
    chatToken     { chatId: str, delta: str }
    chatDone      { chatId, text, provider?, model? }
    chatError     { chatId, code, message }
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Optional, Protocol, runtime_checkable

# --- WS-notification event names (mirror of @loqui/shared CHAT_EVENT) ----------

#: main -> sidecar: begin streaming a chat completion (rides as a notification).
CHAT_REQUEST_EVENT = "chatRequest"
#: sidecar -> main: one streamed token/text delta.
CHAT_TOKEN_EVENT = "chatToken"
#: sidecar -> main: stream finished OK.
CHAT_DONE_EVENT = "chatDone"
#: sidecar -> main: stream failed (actionable error).
CHAT_ERROR_EVENT = "chatError"

#: Provider identifiers (mirror of @loqui/shared CHAT_PROVIDERS). PRD-10 adds the
#: two zero-key on-device providers ``native`` (Apple Foundation Models /
#: NaturalLanguage via the Swift helper) and ``mlx`` (bundled MLX small model).
PROVIDERS = ("anthropic", "ollama", "agent-cli", "native", "mlx", "fake")

#: On-device (zero-key) providers — the "fully on-device, no key" set (mirror of
#: @loqui/shared ONDEVICE_SUMMARY_PROVIDERS). They run through the macOS Swift
#: helper and are gracefully absent on Windows (the selector falls back).
ONDEVICE_PROVIDERS = ("native", "mlx")

#: Default Anthropic chat model (mirror of @loqui/shared DEFAULT_ANTHROPIC_CHAT_MODEL).
#: Per the PRD contract: the official ``anthropic`` SDK, streamed via
#: ``with client.messages.stream(...) as stream: for text in stream.text_stream``,
#: adaptive thinking ``thinking={"type": "adaptive"}``, NO temperature/top_p/top_k
#: or budget_tokens (they 400 on Opus 4.8 / Sonnet 4.6), ``max_tokens`` ~4096.
DEFAULT_ANTHROPIC_CHAT_MODEL = "claude-opus-4-8"
ANTHROPIC_CHAT_MODELS = ("claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5")

#: Chat ``max_tokens`` default for the Anthropic provider (PRD contract).
DEFAULT_CHAT_MAX_TOKENS = 4096

#: Default Ollama base URL (mirror of @loqui/shared DEFAULT_OLLAMA_BASE_URL).
DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"


@dataclass(frozen=True)
class ChatMessage:
    """One conversation message — mirror of the TS ``ChatMessage``.

    ``role`` is ``"system"`` (handler-injected grounding/context), ``"user"``, or
    ``"assistant"``. Built from the inbound ``chatRequest.messages`` (the handler
    prepends its own system/context message; see :class:`ChatProvider`).
    """

    role: str  # "system" | "user" | "assistant"
    content: str

    @classmethod
    def from_wire(cls, obj: dict) -> "ChatMessage":
        return cls(role=str(obj.get("role", "user")), content=str(obj.get("content", "")))

    def to_wire(self) -> dict:
        return {"role": self.role, "content": self.content}


@dataclass(frozen=True)
class ProviderConfig:
    """Non-secret provider selection + tuning — mirror of the TS ``ProviderConfig``.

    The API key is deliberately NOT here: it arrives out-of-band on
    :class:`ChatRequest.api_key` (transient; never persisted/logged). No
    sampling params (temperature/top_p/top_k/budget_tokens) by contract.
    """

    provider: str = "fake"
    model: str = DEFAULT_ANTHROPIC_CHAT_MODEL
    base_url: str = DEFAULT_OLLAMA_BASE_URL
    ollama_model: str = "llama3.1"
    cli: str = "claude"
    #: Model id for an on-device provider (PRD-10): the bundled MLX model id for
    #: ``provider == "mlx"`` (e.g. a Qwen/Gemma-class id), or "" to let the helper
    #: pick its default. Ignored by the Apple-native provider (no selectable model).
    native_model: str = ""
    #: Optional custom summary prompt-template text (PRD-10). When set, the PRD-5
    #: summary job uses this verbatim (with ``{transcript}`` replaced by the
    #: read-only transcript) INSTEAD of the built-in SUMMARY_INSTRUCTION, so a user
    #: can pick a TL;DR / decisions / action-items (or their own) template and
    #: regenerate with a different one. Empty string -> the default instruction.
    #: This is a READ-ONLY prompt knob — it never grants any write path.
    summary_template: str = ""

    @classmethod
    def from_wire(cls, obj: Optional[dict]) -> "ProviderConfig":
        obj = obj or {}
        return cls(
            provider=str(obj.get("provider", "fake")),
            model=str(obj.get("model", DEFAULT_ANTHROPIC_CHAT_MODEL)),
            base_url=str(obj.get("baseUrl", DEFAULT_OLLAMA_BASE_URL)),
            ollama_model=str(obj.get("ollamaModel", "llama3.1")),
            cli=str(obj.get("cli", "claude")),
            native_model=str(obj.get("nativeModel", "")),
            summary_template=str(obj.get("summaryTemplate", "")),
        )


@dataclass(frozen=True)
class ChatRequest:
    """A decoded ``chatRequest`` notification (main -> sidecar).

    ``api_key`` is the TRANSIENT BYOK secret main pulled from the OS keychain; the
    sidecar uses it only for the lifetime of the request and NEVER writes it to
    disk or logs. ``meeting_id`` is resolved to transcript text by the handler via
    the read-only :data:`TranscriptReader` — the transcript is never carried on
    the wire.
    """

    chat_id: str
    meeting_id: str
    messages: list[ChatMessage]
    config: ProviderConfig
    api_key: Optional[str] = None

    @classmethod
    def from_wire(cls, obj: dict) -> "ChatRequest":
        msgs = [ChatMessage.from_wire(m) for m in (obj.get("messages") or [])]
        return cls(
            chat_id=str(obj.get("chatId", "")),
            meeting_id=str(obj.get("meetingId", "")),
            messages=msgs,
            config=ProviderConfig.from_wire(obj.get("providerConfig")),
            api_key=obj.get("apiKey"),
        )


# --- Read-only transcript accessor --------------------------------------------


#: Signature of the READ-ONLY transcript accessor the handler hands a provider's
#: context builder. Given a ``meeting_id`` (and optional variant), it returns the
#: transcript text — or ``""`` when absent — and CANNOT write. This is the only
#: transcript surface the chat/provider layer ever touches; there is no write
#: counterpart in this package. The default implementation lives in
#: :mod:`loqui_sidecar.providers.transcript` and reads
#: ``<LOQUI_DATA_DIR>/meetings/<id>/transcript.live.md`` (or the diarized variant
#: when present) with ``open(..., "r")`` only.
@runtime_checkable
class TranscriptReader(Protocol):
    """READ-ONLY transcript accessor. MUST NOT expose any write path."""

    def read(self, meeting_id: str, variant: str = "live") -> str:
        """Return the meeting transcript text for ``variant`` (``""`` if absent)."""
        ...


# --- Provider error -----------------------------------------------------------

#: Stable error codes (mirror of @loqui/shared CHAT_ERROR_CODES).
CHAT_ERROR_CODES = (
    "missing_api_key",
    "auth_error",
    "ollama_unreachable",
    "cli_not_found",
    "cli_error",
    "provider_error",
    "meeting_not_found",
    "internal_error",
)


class ChatProviderError(Exception):
    """A provider failure with a stable :data:`CHAT_ERROR_CODES` code + an
    actionable, secret-free message.

    The handler maps this to a ``chatError`` notification. ``message`` must be
    safe to surface to the user and to log — providers MUST NOT include the api
    key (or any secret) in it.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code if code in CHAT_ERROR_CODES else "internal_error"
        super().__init__(message)


# --- ChatProvider protocol ----------------------------------------------------


@dataclass
class ChatResult:
    """What a provider stream produced (for the ``chatDone`` notification).

    The handler accumulates the yielded deltas into ``text``; ``provider``/
    ``model`` echo what actually served the response for the active-provider
    indicator. Returned by :meth:`ChatProvider.stream_chat` as the generator's
    ``StopIteration.value`` is NOT used — the handler tracks text itself; this
    type exists so a provider can OPTIONALLY report the served model/provider.
    """

    provider: str = ""
    model: str = ""


@runtime_checkable
class ChatProvider(Protocol):
    """The single, minimal chat interface every backend implements — identical
    across Anthropic / Ollama / agent-CLI / fake so PRD-5 summaries can call it
    with no special-casing.

    Contract:

    * :attr:`name` — short identifier (e.g. ``"anthropic"``, ``"ollama"``,
      ``"agent-cli:claude"``, ``"fake"``) surfaced in the ``chatDone`` indicator.
    * :meth:`stream_chat` — given the full ``messages`` (the handler has already
      prepended a ``system`` message carrying the READ-ONLY transcript context)
      and the resolved :class:`ProviderConfig`, YIELD output text deltas (strings)
      in order. The handler turns each yielded delta into one ``chatToken``
      notification and assembles ``chatDone.text``. The provider receives NO
      transcript writer/store — it cannot mutate any transcript/meta file.

      Raises :class:`ChatProviderError` (with a stable code) on a recoverable,
      user-actionable failure (missing key, Ollama down, CLI absent, provider
      4xx). MUST NOT leak the api key into the exception message. A partial
      stream that then errors is allowed — already-yielded deltas stand and the
      handler emits ``chatError`` after them.

    Anthropic specifics the BYOK build unit MUST honor (pinned here so all
    consumers agree): official ``anthropic`` SDK (NOT raw httpx);
    ``anthropic.Anthropic(api_key=<byok>)`` constructed per-request from
    :attr:`ChatRequest.api_key` (never persisted); stream via
    ``with client.messages.stream(model=config.model, max_tokens=4096,
    thinking={"type": "adaptive"}, system=<context>, messages=[...]) as stream:
    for text in stream.text_stream: yield text``; do NOT pass temperature/top_p/
    top_k or budget_tokens; map ``anthropic.APIStatusError`` (401/403 ->
    ``auth_error``, 4xx -> ``provider_error``) to :class:`ChatProviderError`.
    """

    @property
    def name(self) -> str: ...

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]: ...
