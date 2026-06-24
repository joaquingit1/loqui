"""Chat handler entry point (PRD-4) — the seam ``app.py``'s WS ``chatRequest``
dispatch calls, and the home of provider selection + read-only context building.

Flow (one ``chatRequest`` notification -> a stream of ``chatToken``s, then one
``chatDone`` or ``chatError``)::

    app.py receives a {type:"notification", event:"chatRequest", data:{...}} frame
      -> handle_chat(ChatRequest.from_wire(data), emit, reader=...)
      -> reader.read(meeting_id) (READ-ONLY) -> grounding context
      -> select_provider(config) -> ChatProvider
      -> for delta in provider.stream_chat([system(context), *messages], config, api_key):
             emit(CHAT_TOKEN_EVENT, {"chatId", "delta"})
      -> emit(CHAT_DONE_EVENT, {"chatId", "text", "provider", "model"})
      (on ChatProviderError / unexpected error -> emit(CHAT_ERROR_EVENT, {...}))

``emit`` is the per-connection notification sender app.py already owns
(``state.notify``: ``send(event, data)`` — see :func:`_install_transcript_emitter`).
The handler runs OFF the WS receive loop (app.py submits it to a worker) because a
provider call is slow/blocking; ``emit`` is thread-safe (it schedules onto the
serving loop).

INVARIANT: the handler depends only on the READ-ONLY :data:`TranscriptReader`
(no store, no TranscriptWriter, no file handle opened for writing) and hands the
provider only the conversation + context string. There is structurally no path
here that writes a transcript/meta file. The ``api_key`` is used transiently and
NEVER logged.

Foundation ships the FAKE provider + the selection seam; the real
``anthropic``/``ollama``/``agent-cli`` providers are injected by the build units
via :func:`make_provider_selector` (the default selector raises an actionable
``ChatProviderError`` for not-yet-wired providers so the contract is honest).
"""

from __future__ import annotations

import logging
from typing import Callable, Optional

from .fake import FakeChatProvider, fake_chat_enabled
from .transcript import default_transcript_reader
from .types import (
    CHAT_DONE_EVENT,
    CHAT_ERROR_EVENT,
    CHAT_TOKEN_EVENT,
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    ChatRequest,
    ProviderConfig,
    TranscriptReader,
)

logger = logging.getLogger("loqui_sidecar.providers.handler")

#: The low-level WS notification sender app.py owns: ``emit(event, data)``. Each
#: call becomes one ``{type:"notification", event, data}`` frame on the live WS.
#: Thread-safe (schedules onto the serving loop). Same type as the transcription
#: ``NotificationSender``.
ChatEmit = Callable[[str, dict], None]

#: Builds a :class:`ChatProvider` for a resolved :class:`ProviderConfig`. The
#: build units inject a selector that returns the real Anthropic/Ollama/agent-CLI
#: providers; Foundation's default returns the FAKE provider for ``"fake"`` and
#: raises an actionable :class:`ChatProviderError` for the others (until wired).
ProviderSelector = Callable[[ProviderConfig], ChatProvider]

#: Cap on how much transcript text is injected as context before the documented
#: chunk/keyword/recency fallback engages (the build unit implements the
#: fallback; Foundation passes the full transcript for normal meetings). ~24k
#: chars ≈ a long meeting; beyond this the build unit trims to recent + keyword
#: hits. Defined here so the threshold is one symbol all consumers reference.
CONTEXT_CHAR_BUDGET = 24_000


def build_context_message(reader: TranscriptReader, meeting_id: str) -> Optional[ChatMessage]:
    """Read the meeting transcript READ-ONLY and wrap it as a ``system`` message.

    Returns ``None`` when there is no transcript text yet (the handler then sends
    no context message). For very long transcripts the build unit replaces the
    naive truncation here with the documented chunk + keyword/recency fallback;
    Foundation passes the full transcript (capped at :data:`CONTEXT_CHAR_BUDGET`).
    """
    text = reader.read(meeting_id, "live")
    if not text.strip():
        return None
    if len(text) > CONTEXT_CHAR_BUDGET:
        # Foundation fallback: keep the most-recent tail (the build unit swaps in
        # chunk+keyword retrieval). Documented threshold = CONTEXT_CHAR_BUDGET.
        text = text[-CONTEXT_CHAR_BUDGET:]
    content = (
        "You are a helpful assistant answering questions about a meeting. "
        "Use ONLY the following transcript as ground truth; do not invent facts. "
        "The transcript is read-only context.\n\n"
        "<transcript>\n" + text + "\n</transcript>"
    )
    return ChatMessage(role="system", content=content)


def _default_provider_selector(config: ProviderConfig) -> ChatProvider:
    """Foundation selector: FAKE for ``"fake"`` / ``LOQUI_FAKE_CHAT``; the real
    providers raise an actionable error until their build units wire them in.
    """
    if config.provider == "fake" or fake_chat_enabled():
        return FakeChatProvider()
    raise ChatProviderError(
        "internal_error",
        f"chat provider {config.provider!r} is not wired yet "
        "(Foundation ships only the fake provider)",
    )


def make_provider_selector(
    *,
    anthropic_factory: Optional[Callable[[], ChatProvider]] = None,
    ollama_factory: Optional[Callable[[ProviderConfig], ChatProvider]] = None,
    agent_cli_factory: Optional[Callable[[ProviderConfig], ChatProvider]] = None,
) -> ProviderSelector:
    """Build a :data:`ProviderSelector` from the real provider factories.

    The build units call this with their concrete factories; the unit gate keeps
    the default (fake-only) selector. ``LOQUI_FAKE_CHAT`` always wins (forces the
    fake) so the gate + smoke stay hermetic even if a config requests a real
    provider.
    """

    def select(config: ProviderConfig) -> ChatProvider:
        if fake_chat_enabled():
            return FakeChatProvider()
        provider = config.provider
        if provider == "fake":
            return FakeChatProvider()
        if provider == "anthropic" and anthropic_factory is not None:
            return anthropic_factory()
        if provider == "ollama" and ollama_factory is not None:
            return ollama_factory(config)
        if provider == "agent-cli" and agent_cli_factory is not None:
            return agent_cli_factory(config)
        raise ChatProviderError(
            "internal_error",
            f"chat provider {provider!r} is not available",
        )

    return select


def handle_chat(
    request: ChatRequest,
    emit: ChatEmit,
    *,
    reader: Optional[TranscriptReader] = None,
    selector: Optional[ProviderSelector] = None,
) -> None:
    """Run one chat request to completion, streaming results via ``emit``.

    * builds the READ-ONLY transcript context (``reader`` defaults to the on-disk
      :class:`FsTranscriptReader`);
    * selects the provider (``selector`` defaults to the Foundation fake-only
      selector);
    * streams ``chatToken`` deltas, then a terminal ``chatDone``;
    * on :class:`ChatProviderError` (or any unexpected error) emits a single
      ``chatError`` with a stable code + a secret-free message — never raising
      into app.py's worker.

    NEVER logs ``request.api_key``. Never opens a transcript/meta file for
    writing (it has no writer — only ``reader``).
    """
    reader = reader or default_transcript_reader()
    selector = selector or _default_provider_selector
    chat_id = request.chat_id
    try:
        context = build_context_message(reader, request.meeting_id)
        messages: list[ChatMessage] = []
        if context is not None:
            messages.append(context)
        messages.extend(request.messages)

        provider = selector(request.config)
        assembled: list[str] = []
        for delta in provider.stream_chat(messages, request.config, request.api_key):
            if not delta:
                continue
            assembled.append(delta)
            emit(CHAT_TOKEN_EVENT, {"chatId": chat_id, "delta": delta})

        emit(
            CHAT_DONE_EVENT,
            {
                "chatId": chat_id,
                "text": "".join(assembled),
                "provider": request.config.provider,
                "model": getattr(provider, "name", request.config.provider),
            },
        )
    except ChatProviderError as exc:
        logger.warning("chat %s failed: [%s] %s", chat_id, exc.code, exc)
        emit(CHAT_ERROR_EVENT, {"chatId": chat_id, "code": exc.code, "message": str(exc)})
    except Exception:  # noqa: BLE001 - a provider crash must not kill the WS/worker.
        logger.exception("chat %s crashed", chat_id)
        emit(
            CHAT_ERROR_EVENT,
            {
                "chatId": chat_id,
                "code": "internal_error",
                "message": "chat request failed unexpectedly",
            },
        )
