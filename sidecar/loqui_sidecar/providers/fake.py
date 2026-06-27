"""FakeChatProvider — a deterministic, scripted token stream (PRD-4).

Hermetic: no network, no API key, no CLI, no model. The DEFAULT unit gate + the
``smoke:chat`` harness select this (``providerConfig.provider="fake"`` or the
``LOQUI_FAKE_CHAT`` env flag) so the chat path is exercised end-to-end without
any external dependency.

It echoes a short, transcript-grounded reply token-by-token so tests can assert
both streaming behavior AND that the (read-only) transcript context reached the
provider — while NEVER touching any transcript/meta file.
"""

from __future__ import annotations

import os
from typing import Iterator, Optional

from .types import ChatMessage, ProviderConfig

#: Env flag that forces the FAKE chat provider regardless of ``providerConfig``
#: (set for the unit gate + ``smoke:chat``). Mirrors ``LOQUI_FAKE_ASR``.
FAKE_CHAT_ENV = "LOQUI_FAKE_CHAT"


def fake_chat_enabled() -> bool:
    val = os.environ.get(FAKE_CHAT_ENV)
    return bool(val) and val not in ("0", "false", "False", "")


class FakeChatProvider:
    """Deterministic scripted provider. Yields a fixed reply as word-by-word
    deltas, deriving a couple of tokens from the conversation/context so a test
    can prove the grounding context was passed in. Never raises for normal
    input; never persists anything.
    """

    name = "fake"

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        # Surface a deterministic marker so tests can assert the read-only
        # transcript actually reached the provider. Key on the `<transcript>`
        # marker in ANY message (chat puts it in the system grounding message;
        # the summary puts it in the user turn) — NOT merely "a system message
        # exists", since the handler also adds a language directive system message
        # even when there is no transcript.
        has_context = any("<transcript>" in (m.content or "") for m in messages)
        last_user = next(
            (m.content for m in reversed(messages) if m.role == "user"),
            "",
        )
        reply = [
            "[fake]",
            "context" if has_context else "no-context",
            "reply",
            "to:",
            (last_user.strip().split("\n", 1)[0] or "(empty)"),
        ]
        for i, word in enumerate(reply):
            yield (word if i == 0 else " " + word)
