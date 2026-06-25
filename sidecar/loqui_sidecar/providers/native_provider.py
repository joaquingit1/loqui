"""Native on-device summary/chat :class:`ChatProvider`s (PRD-10).

Two **zero-key, on-device** providers that conform to the SAME PRD-4
:class:`~loqui_sidecar.providers.types.ChatProvider` interface chat + PRD-5
summaries already use, so they need no special-casing anywhere:

* :class:`NativeChatProvider` (``provider == "native"``) — drives the macOS Swift
  helper (the PRD-9 ``loqui-asr-helper`` binary, extended in this PRD with summary
  methods) over a documented **line/JSON protocol**. It prefers Apple **Foundation
  Models** (the on-device Apple-Intelligence LLM, macOS 26 + Apple Intelligence
  enabled) and falls back to Apple **NaturalLanguage** extractive highlights when
  the generative model is unavailable. Zero download, zero key, fully on-device.
* :class:`BundledMlxProvider` (``provider == "mlx"``) — a bundled small MLX
  instruct model (Qwen/Gemma-class) on Apple Silicon, downloaded on first use
  then fully offline. The first-run model fetch is behind an injectable seam; the
  actual MLX inference runs through the SAME Swift helper protocol (the helper
  owns the model cache + MLX runtime), so on Windows / unbundled it is simply
  unavailable and the selector falls back.

REUSE (no rewrite): both providers reuse the PRD-9 helper-process injection seam
(:class:`~loqui_sidecar.transcription.native_backend.HelperProcess` /
:class:`SubprocessHelper` / :func:`resolve_helper_binary`) so tests inject a FAKE
helper that scripts the documented protocol — NO Swift binary, NO model, NO
network in the gate. Only the real Swift compile + the real Apple Models / MLX run
are Mac/CI-only (an opt-in test, skipped on Windows).

CROSS-CUTTING INVARIANT (the headline of PRD-4/PRD-10): **the AI never edits the
transcript.** Like every other provider, a native provider receives only the
conversation + a READ-ONLY context string (folded into ``messages`` by the
handler) and YIELDS output text. It is handed NO writer/store/file handle — it
cannot mutate ``transcript.live.md`` / the diarized variants / ``meta.json``. The
existing summary-writer persists ``summary.json``; the provider has no write path.

--------------------------------------------------------------------------------
HELPER SUMMARY LINE/JSON PROTOCOL (host == Python sidecar; helper == Swift binary)
--------------------------------------------------------------------------------
Additive to the PRD-9 ASR protocol (same channel, parsed by ``type``). One JSON
object per line (``\n``-terminated, UTF-8), both directions.

Host -> helper:
  {"type": "summaryProbe"}
      Ask which summary engines this OS/arch supports (Apple Foundation Models,
      Apple NaturalLanguage, bundled MLX). The helper replies ``summaryCapabilities``.
  {"type": "summaryStart", "engine": "apple-foundation"|"apple-nl"|"mlx",
                           "model": "<id>"|null}
      Begin a summary session for the chosen engine (loads/fetches the model for
      ``mlx``). Replies ``summaryReady`` (or ``error`` -> the host falls back).
  {"type": "summaryGenerate", "prompt": "<full prompt incl. transcript>"}
      Generate text for the prompt. The helper replies with ONE ``summaryResult``
      carrying the generated/extracted text (the protocol is request/response, not
      a token stream — the host treats the whole result as a single delta).
  {"type": "summaryStop"}
      End the session (release the model).

Helper -> host:
  {"type": "summaryCapabilities", "engines": ["apple-foundation", "apple-nl", ...],
                                  "os": "darwin", "arch": "arm64"}
  {"type": "summaryReady", "engine": "...", "model": "..."}
  {"type": "summaryResult", "text": "..."}
  {"type": "error", "code": "...", "message": "..."}
      A recoverable error (model unavailable, permission, fetch failed). The
      provider maps it to a stable :class:`ChatProviderError` so the handler /
      runner degrade gracefully (chat shows the error; summary marks that stage
      "error" and the meeting still finalizes).

The host always reads lines until it sees the response matching its request,
tolerating + logging any unrecognized line (forward-compatible).
"""

from __future__ import annotations

import json
import logging
from typing import Iterator, List, Optional

from ..transcription.native_backend import (
    HelperProcess,
    _default_subprocess_factory,
)
from .types import ChatMessage, ChatProviderError, ProviderConfig

logger = logging.getLogger("loqui_sidecar.providers.native")

#: Native summary engines the Swift helper can drive (mirror of @loqui/shared
#: SUMMARY_PROVIDERS' on-device engines). ``apple-foundation`` is the preferred
#: generative target; ``apple-nl`` is the extractive fallback; ``mlx`` is the
#: bundled small instruct model (first-run fetch).
SUMMARY_ENGINE_APPLE_FOUNDATION = "apple-foundation"
SUMMARY_ENGINE_APPLE_NL = "apple-nl"
SUMMARY_ENGINE_MLX = "mlx"

#: Bounded line reads so a wedged/garbled helper never hangs the provider.
_MAX_LINES = 256


def render_prompt(messages: list[ChatMessage]) -> str:
    """Flatten the conversation (incl. the read-only context system message) into
    a single prompt string for the helper. READ-ONLY: builds a string only — it
    never opens or mutates any transcript/meta file.
    """
    parts: list[str] = []
    for m in messages:
        if not m.content:
            continue
        if m.role == "system":
            parts.append(m.content)
        elif m.role == "assistant":
            parts.append(f"Assistant: {m.content}")
        else:
            parts.append(f"User: {m.content}")
    return "\n\n".join(parts)


def probe_summary_capabilities(helper_factory=None) -> List[str]:
    """Ask the helper which native SUMMARY engines are available on this OS/arch.

    Exported for the forthcoming availability UI; it is not yet called from a
    health or provider-selector path.

    Spawns a short-lived helper (via ``helper_factory`` or the default subprocess
    factory), sends ``{"type":"summaryProbe"}``, and returns the engine list from
    the ``summaryCapabilities`` reply. Returns ``[]`` when no helper is available
    (Windows / unbundled) or on any error — the empty list is the "no native
    summary engines" signal the selector falls back on. Never raises.
    """
    factory = helper_factory or _default_subprocess_factory()
    if factory is None:
        return []
    helper: Optional[HelperProcess] = None
    try:
        helper = factory()
        helper.send_line(json.dumps({"type": "summaryProbe"}))
        for _ in range(_MAX_LINES):
            raw = helper.read_line()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if isinstance(msg, dict) and msg.get("type") == "summaryCapabilities":
                engines = msg.get("engines")
                if isinstance(engines, list):
                    return [e for e in engines if isinstance(e, str)]
                return []
        return []
    except Exception:  # noqa: BLE001 - a probe failure is "no native engines".
        logger.warning("native summary capability probe failed", exc_info=True)
        return []
    finally:
        if helper is not None:
            try:
                helper.close()
            except Exception:  # noqa: BLE001
                pass


class _HelperSummaryProvider:
    """Shared base: a :class:`ChatProvider` that runs ONE summary/chat generation
    through the Swift helper's summary protocol.

    Subclasses pick the ``engine`` + the public :attr:`name`. ``helper_factory``
    is the injectable seam (the PRD-9 ``HelperProcess`` factory): production spawns
    the resolved helper binary; tests inject a fake helper scripting the protocol.
    When the factory is ``None`` (no helper — Windows / unbundled) the provider
    raises a stable, actionable :class:`ChatProviderError` so the selector's
    fallback engages — a missing helper never reaches a meeting.

    READ-ONLY: there is no writer/store/file handle here. The provider only sends
    a prompt string and reads back generated text.
    """

    engine: str = SUMMARY_ENGINE_APPLE_FOUNDATION
    _name: str = "native"
    #: Stable code emitted when no helper binary is available (the fallback signal).
    _unavailable_code = "provider_error"

    def __init__(self, config: Optional[ProviderConfig] = None, helper_factory=None) -> None:
        self._config = config
        self._model = (config.native_model if config else "") or ""
        # Default to the real subprocess factory; tests inject a fake. A None
        # factory means "no helper available" -> stream_chat raises -> selector
        # (or the caller's try/except) falls back.
        self._factory = (
            helper_factory if helper_factory is not None else _default_subprocess_factory()
        )

    @property
    def name(self) -> str:
        suffix = f":{self._model}" if self._model else ""
        return f"{self._name}{suffix}"

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        if self._factory is None:
            raise ChatProviderError(
                self._unavailable_code,
                f"The on-device {self._name!r} provider is unavailable on this "
                "system (no native helper). Pick Ollama, a cloud provider, or run "
                "on macOS.",
            )
        prompt = render_prompt(messages)
        helper: Optional[HelperProcess] = None
        try:
            helper = self._factory()
            self._start(helper)
            text = self._generate(helper, prompt)
            if text:
                yield text
        except ChatProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize transport errors.
            raise ChatProviderError(
                "provider_error", f"The on-device {self._name!r} provider failed."
            ) from exc
        finally:
            if helper is not None:
                try:
                    helper.send_line(json.dumps({"type": "summaryStop"}))
                except Exception:  # noqa: BLE001 - best effort.
                    pass
                try:
                    helper.close()
                except Exception:  # noqa: BLE001
                    pass

    def _start(self, helper: HelperProcess) -> None:
        """Send ``summaryStart`` + wait (bounded) for ``summaryReady`` (or error)."""
        helper.send_line(
            json.dumps(
                {
                    "type": "summaryStart",
                    "engine": self.engine,
                    "model": self._model or None,
                }
            )
        )
        for _ in range(_MAX_LINES):
            raw = helper.read_line()
            if raw is None:
                break
            msg = self._decode(raw)
            if msg is None:
                continue
            mtype = msg.get("type")
            if mtype == "summaryReady":
                return
            if mtype == "error":
                raise self._map_error(msg)
            # Unrecognized line: skip (forward-compatible).
        raise ChatProviderError(
            "provider_error",
            f"The on-device {self._name!r} provider did not become ready.",
        )

    def _generate(self, helper: HelperProcess, prompt: str) -> str:
        """Send ``summaryGenerate`` + read back the single ``summaryResult`` text."""
        helper.send_line(json.dumps({"type": "summaryGenerate", "prompt": prompt}))
        for _ in range(_MAX_LINES):
            raw = helper.read_line()
            if raw is None:
                break
            msg = self._decode(raw)
            if msg is None:
                continue
            mtype = msg.get("type")
            if mtype == "summaryResult":
                text = msg.get("text")
                return text if isinstance(text, str) else ""
            if mtype == "error":
                raise self._map_error(msg)
            # Unrecognized line: skip.
        raise ChatProviderError(
            "provider_error",
            f"The on-device {self._name!r} provider returned no result.",
        )

    @staticmethod
    def _decode(raw: str) -> Optional[dict]:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            return None
        return msg if isinstance(msg, dict) else None

    def _map_error(self, msg: dict) -> ChatProviderError:
        code = str(msg.get("code") or "provider_error")
        message = str(msg.get("message") or "on-device summary failed")
        # Keep the helper's actionable message but never trust it as a stable code.
        return ChatProviderError("provider_error", f"{self._name}: {message} ({code})")


class NativeChatProvider(_HelperSummaryProvider):
    """Apple-native on-device provider (``provider == "native"``).

    Drives the Swift helper's ``apple-foundation`` engine (Apple Foundation Models,
    the on-device LLM) by default, with the helper degrading to ``apple-nl`` (Apple
    NaturalLanguage extractive) when the generative model is unavailable. Zero key,
    zero download, fully on-device.
    """

    engine = SUMMARY_ENGINE_APPLE_FOUNDATION
    _name = "native"


class BundledMlxProvider(_HelperSummaryProvider):
    """Bundled-MLX on-device provider (``provider == "mlx"``), Apple Silicon.

    Drives the Swift helper's ``mlx`` engine: a small instruct model (Qwen/Gemma-
    class) the helper downloads on first use (the first-run fetch seam lives in the
    helper's ``summaryStart`` handler) and then runs fully offline. No Ollama
    dependency. Unavailable (and thus fallen-back-from) on Windows / unbundled.
    """

    engine = SUMMARY_ENGINE_MLX
    _name = "mlx"


def native_factory(config: ProviderConfig) -> NativeChatProvider:
    """Build the Apple-native provider for ``config`` (for ``make_provider_selector``)."""
    return NativeChatProvider(config)


def mlx_factory(config: ProviderConfig) -> BundledMlxProvider:
    """Build the bundled-MLX provider for ``config`` (for ``make_provider_selector``)."""
    return BundledMlxProvider(config)
