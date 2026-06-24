"""Ollama (local) :class:`ChatProvider` (PRD-4 build unit).

Fully offline: streams from a locally-running Ollama daemon via ``httpx``. Uses
the native ``POST /api/chat`` endpoint with ``stream=true``, which returns a
stream of newline-delimited JSON objects, each ``{"message": {"content": "..."},
"done": false}`` until a final ``{"done": true}``.

The base URL is configurable (``ProviderConfig.base_url``, default
``http://localhost:11434``) and the model is the user's pulled model
(``ProviderConfig.ollama_model``). A missing/unreachable daemon raises a stable,
actionable :class:`ChatProviderError` (``ollama_unreachable``) — never a crash.

No transcript writer is reachable from here; the provider only sees the
conversation + read-only context (folded into ``messages`` by the handler).
"""

from __future__ import annotations

import json
from typing import Iterator, Optional

from .types import (
    DEFAULT_OLLAMA_BASE_URL,
    ChatMessage,
    ChatProviderError,
    ProviderConfig,
)

#: Native Ollama chat endpoint (streams JSONL deltas).
CHAT_PATH = "/api/chat"
#: A streamed chat read can run a while on a local model; give it room but bound
#: the connect phase so an absent daemon fails fast and actionably.
_CONNECT_TIMEOUT_S = 5.0


class OllamaProvider:
    """Streaming chat over a local Ollama daemon's native ``/api/chat``.

    ``client_factory`` is a test seam: defaults to a real ``httpx.Client`` bound
    to ``base_url``; tests inject a fake client to assert request shaping (URL,
    model, ``stream=true``, the messages payload) with no network.
    """

    def __init__(self, config: ProviderConfig, client_factory=None) -> None:
        self._base_url = (config.base_url or DEFAULT_OLLAMA_BASE_URL).rstrip("/")
        self._model = config.ollama_model or "llama3.1"
        self._client_factory = client_factory

    @property
    def name(self) -> str:
        return f"ollama:{self._model}"

    def _make_client(self):
        if self._client_factory is not None:
            return self._client_factory(self._base_url)
        import httpx  # noqa: PLC0415

        # Connect timeout fails fast if the daemon is down; no read timeout so a
        # slow local generation isn't cut off mid-stream.
        timeout = httpx.Timeout(None, connect=_CONNECT_TIMEOUT_S)
        return httpx.Client(base_url=self._base_url, timeout=timeout)

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        # Ollama's native chat accepts system/user/assistant roles directly, so the
        # handler's prepended system (transcript context) message rides along.
        payload = {
            "model": self._model,
            "stream": True,
            "messages": [{"role": m.role, "content": m.content} for m in messages if m.content],
        }

        client = self._make_client()
        try:
            with client:
                yield from self._stream(client, payload)
        except ChatProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize transport errors.
            raise self._map_error(exc) from None

    def _stream(self, client, payload: dict) -> Iterator[str]:
        with client.stream("POST", CHAT_PATH, json=payload) as response:
            status = getattr(response, "status_code", 200)
            if status >= 400:
                raise ChatProviderError(
                    "provider_error",
                    f"Ollama returned HTTP {status}. Is the model "
                    f"'{self._model}' pulled? Try: ollama pull {self._model}",
                )
            for line in response.iter_lines():
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if obj.get("error"):
                    raise ChatProviderError("provider_error", f"Ollama error: {obj['error']}")
                delta = (obj.get("message") or {}).get("content", "")
                if delta:
                    yield delta
                if obj.get("done"):
                    break

    def _map_error(self, exc: Exception) -> ChatProviderError:
        """Map an ``httpx`` transport failure to a stable, actionable error."""
        try:
            import httpx  # noqa: PLC0415

            if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
                return ChatProviderError(
                    "ollama_unreachable",
                    f"Could not reach Ollama at {self._base_url}. Is it running? "
                    "Start it with `ollama serve`.",
                )
            if isinstance(exc, httpx.HTTPError):
                return ChatProviderError(
                    "ollama_unreachable",
                    f"Ollama request failed against {self._base_url}.",
                )
        except Exception:  # noqa: BLE001 - httpx missing/odd; fall through.
            pass
        return ChatProviderError("provider_error", "The Ollama provider failed.")


def ollama_factory(config: ProviderConfig) -> OllamaProvider:
    """Build an Ollama provider for ``config`` (for ``make_provider_selector``)."""
    return OllamaProvider(config)
