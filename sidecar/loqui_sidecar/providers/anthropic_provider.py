"""Anthropic BYOK :class:`ChatProvider` (PRD-4 build unit).

Uses the **official** ``anthropic`` Python SDK (NOT raw httpx). The API key is
passed in transiently per request (from main, pulled from the OS keychain) and is
NEVER persisted, logged, or placed in an exception message.

Contract pinned by Foundation (see ``providers/types.py``):

* construct ``anthropic.Anthropic(api_key=<byok>)`` per request;
* stream via ``with client.messages.stream(model=..., max_tokens=4096,
  thinking={"type": "adaptive"}, system=<context>, messages=[...]) as stream:
  for text in stream.text_stream: yield text``;
* default model ``claude-opus-4-8`` (also ``claude-sonnet-4-6`` /
  ``claude-haiku-4-5``);
* do NOT pass ``temperature`` / ``top_p`` / ``top_k`` or ``budget_tokens`` — they
  ``400`` on Opus 4.8 / Sonnet 4.6;
* map typed ``anthropic`` exceptions to :class:`ChatProviderError` with a stable
  code (401/403 -> ``auth_error``; other API status -> ``provider_error``;
  connection failure -> ``provider_error``).

The provider receives only the conversation + the read-only context (already
folded into the messages by the handler) — it is handed no transcript writer and
cannot mutate any transcript/meta file.
"""

from __future__ import annotations

from typing import Iterator, Optional

from .types import (
    DEFAULT_ANTHROPIC_CHAT_MODEL,
    DEFAULT_CHAT_MAX_TOKENS,
    ChatMessage,
    ChatProviderError,
    ProviderConfig,
)

#: Adaptive thinking config (the only thinking shape the PRD allows — no
#: ``budget_tokens``, which 400s on Opus 4.8 / Sonnet 4.6).
ADAPTIVE_THINKING = {"type": "adaptive"}


class AnthropicProvider:
    """BYOK Anthropic chat provider over the official SDK.

    ``client_factory`` exists purely as a test seam: it defaults to constructing a
    real ``anthropic.Anthropic(api_key=...)`` lazily (so importing this module
    never requires the SDK at collection time and the default unit gate, which
    uses the fake provider, stays hermetic). Tests inject a fake factory to assert
    request shaping without any network call.
    """

    name = "anthropic"

    def __init__(self, client_factory=None) -> None:
        self._client_factory = client_factory

    def _make_client(self, api_key: str):
        if self._client_factory is not None:
            return self._client_factory(api_key)
        # Lazy import: keeps the hermetic (fake-provider) gate from importing the
        # SDK and lets this module be imported even where anthropic is absent.
        import anthropic  # noqa: PLC0415

        return anthropic.Anthropic(api_key=api_key)

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        if not api_key or not api_key.strip():
            raise ChatProviderError(
                "missing_api_key",
                "No Anthropic API key configured. Add your key in Settings.",
            )

        # The Messages API takes the grounding/context as the top-level `system`
        # parameter, and only user/assistant turns in `messages`. The handler
        # prepends a single `system` ChatMessage carrying the read-only transcript
        # context; split it out here.
        system_text = "\n\n".join(m.content for m in messages if m.role == "system")
        convo = [
            {"role": m.role, "content": m.content}
            for m in messages
            if m.role in ("user", "assistant") and m.content
        ]
        if not convo:
            # The SDK requires at least one non-system message.
            convo = [{"role": "user", "content": ""}]

        model = (
            config.model or DEFAULT_ANTHROPIC_CHAT_MODEL
        ).strip() or DEFAULT_ANTHROPIC_CHAT_MODEL

        # Only pass `system` when there is grounding context (an empty string is a
        # valid omission). NO temperature/top_p/top_k/budget_tokens by contract.
        stream_kwargs: dict = {
            "model": model,
            "max_tokens": DEFAULT_CHAT_MAX_TOKENS,
            "thinking": ADAPTIVE_THINKING,
            "messages": convo,
        }
        if system_text:
            stream_kwargs["system"] = system_text

        try:
            client = self._make_client(api_key)
            with client.messages.stream(**stream_kwargs) as stream:
                for text in stream.text_stream:
                    if text:
                        yield text
        except ChatProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize SDK errors below.
            raise self._map_error(exc) from None

    @staticmethod
    def _map_error(exc: Exception) -> ChatProviderError:
        """Map a typed ``anthropic`` exception to a stable, secret-free error.

        Never includes the api key (the SDK exceptions don't carry it, and we use
        only the exception's class/status, not its repr).
        """
        status = getattr(exc, "status_code", None)
        # Auth failures (bad/expired key, no access) -> actionable auth_error.
        try:
            import anthropic  # noqa: PLC0415

            if isinstance(exc, anthropic.AuthenticationError) or status in (401, 403):
                return ChatProviderError(
                    "auth_error",
                    "Anthropic rejected the API key (authentication failed). "
                    "Check the key in Settings.",
                )
            if isinstance(exc, anthropic.APIConnectionError):
                return ChatProviderError(
                    "provider_error",
                    "Could not reach the Anthropic API (connection error).",
                )
            if isinstance(exc, anthropic.APIStatusError):
                return ChatProviderError(
                    "provider_error",
                    f"Anthropic API error (HTTP {status}).",
                )
        except Exception:  # noqa: BLE001 - SDK missing/odd; fall through.
            if status in (401, 403):
                return ChatProviderError(
                    "auth_error", "Anthropic rejected the API key (authentication failed)."
                )
        return ChatProviderError("provider_error", "The Anthropic provider failed.")


def anthropic_factory() -> AnthropicProvider:
    """Build the default Anthropic provider (for ``make_provider_selector``)."""
    return AnthropicProvider()
