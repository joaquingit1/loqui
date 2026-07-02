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

import atexit
import json
import logging
import os
import threading
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

#: How long a WARM helper process stays alive after its LAST use before an idle
#: reaper shuts it down. The big in-call latency win is REUSING one already-spawned
#: helper across chat turns (no cold spawn + summaryStart handshake per message);
#: the idle timeout is the safety valve so an idle process (e.g. after a chat
#: session ends, or after a one-shot summary) is reclaimed instead of lingering.
#: Env-overridable via ``LOQUI_NATIVE_HELPER_IDLE_SEC`` (seconds; <=0 disables the
#: warm pool entirely -> a fresh helper per call, the pre-warm-pool behavior).
_IDLE_TIMEOUT_ENV = "LOQUI_NATIVE_HELPER_IDLE_SEC"
_DEFAULT_IDLE_TIMEOUT_SEC = 240.0  # 4 minutes since last use.


def _resolved_idle_timeout() -> float:
    """The warm-helper idle timeout in seconds (env-overridable). ``<= 0`` disables
    the warm pool so every call spawns + tears down its own helper (safe fallback).
    """
    raw = os.environ.get(_IDLE_TIMEOUT_ENV)
    if raw is None or raw == "":
        return _DEFAULT_IDLE_TIMEOUT_SEC
    try:
        return float(raw)
    except (TypeError, ValueError):
        return _DEFAULT_IDLE_TIMEOUT_SEC


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


def split_system_user(messages: list[ChatMessage]) -> tuple[str, str]:
    """Split the conversation into (system, user) for the native helper.

    The SYSTEM text (e.g. the notetaker instructions) is sent on the helper's
    `system` channel so Apple Foundation Models follows it as session
    `instructions` (far more reliable than an inlined blob); the rest becomes the
    USER prompt. If there is no system message (e.g. a custom template that owns
    the whole prompt), the system part is empty and everything is the user prompt.
    READ-ONLY: builds strings only.
    """
    system = "\n\n".join(m.content for m in messages if m.role == "system" and m.content)
    user_parts: list[str] = []
    for m in messages:
        if m.role == "system" or not m.content:
            continue
        user_parts.append(m.content if m.role == "user" else f"Assistant: {m.content}")
    user = "\n\n".join(user_parts)
    if not user:  # system-only (shouldn't happen) -> treat it as the user prompt.
        return "", system
    return system, user


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


class _HelperGone(Exception):
    """Internal signal: the warm helper's transport died mid-use (EOF from a
    crashed/exited process, or a raised transport error). The pool respawns a fresh
    helper and retries ONCE so a stale warm process never fails the user's message.
    """


class _WarmHelper:
    """One WARM helper process kept alive across summary/chat calls for a given
    ``(engine, model)``.

    The whole latency win is here: the helper is spawned + handed a ``summaryStart``
    handshake ONCE, then REUSED for every subsequent generation, instead of a cold
    spawn + handshake + teardown per message. Access is serialized by a lock (one
    in-flight generation at a time — the chat executor is single-threaded, so this
    is never contended for chat; it just guards against a summary + chat racing the
    same stdio). An idle reaper shuts the process down after
    :func:`_resolved_idle_timeout` seconds since the last use, and :meth:`close`
    tears it down immediately (provider close / meeting end / process exit).

    READ-ONLY: it only sends prompt strings and reads back generated text — no file
    handle, no writer.
    """

    def __init__(self, engine: str, model: str, factory) -> None:
        self._engine = engine
        self._model = model
        self._factory = factory
        self._helper: Optional[HelperProcess] = None
        self._lock = threading.RLock()
        self._timer: Optional[threading.Timer] = None
        #: Bumped on every (re)arm/use so a STALE reaper — one that fired while a
        #: generation held the lock, after which a new turn re-armed — is a no-op
        #: instead of reaping the freshly-rearmed helper.
        self._epoch = 0

    # -- lifecycle ------------------------------------------------------------

    def _ensure_started(self) -> HelperProcess:
        """Return a started helper, spawning + handshaking one lazily. Caller holds
        the lock. If the handshake fails, the freshly-spawned process is closed
        before re-raising so a failed start never leaks a process."""
        if self._helper is not None:
            return self._helper
        helper = self._factory()
        try:
            _start_summary_session(helper, self._engine, self._model, self._name())
        except BaseException:
            try:
                helper.close()
            except Exception:  # noqa: BLE001 - best effort.
                pass
            raise
        self._helper = helper
        return helper

    def _name(self) -> str:
        return f"{self._engine}{(':' + self._model) if self._model else ''}"

    def _teardown_locked(self) -> None:
        """Best-effort ``summaryStop`` + ``close`` of the live helper. Caller holds
        the lock. Never raises."""
        helper = self._helper
        self._helper = None
        if helper is None:
            return
        try:
            helper.send_line(json.dumps({"type": "summaryStop"}))
        except Exception:  # noqa: BLE001 - best effort.
            pass
        try:
            helper.close()
        except Exception:  # noqa: BLE001
            pass

    def close(self) -> None:
        """Cancel the idle reaper and tear down the helper now. Never raises."""
        with self._lock:
            self._epoch += 1  # invalidate any already-fired-but-blocked reaper.
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._teardown_locked()

    def _arm_idle_reaper(self) -> None:
        """(Re)arm the idle-timeout reaper. Caller holds the lock. A ``<= 0`` timeout
        means the warm pool is disabled -> tear down immediately after this use."""
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        self._epoch += 1
        timeout = _resolved_idle_timeout()
        if timeout <= 0:
            self._teardown_locked()
            return
        epoch = self._epoch
        timer = threading.Timer(timeout, self._on_idle, args=(epoch,))
        timer.daemon = True
        timer.start()
        self._timer = timer

    def _on_idle(self, epoch: int) -> None:
        with self._lock:
            if epoch != self._epoch:
                return  # a newer turn re-armed after this timer fired; stale -> no-op.
            self._timer = None
            self._teardown_locked()

    # -- generation -----------------------------------------------------------

    def stream_generate(self, prompt: str, system: str) -> Iterator[str]:
        """Lease the warm helper, stream one generation, then re-arm the idle reaper.

        A dead/crashed helper (EOF or transport error) must NOT fail the user's
        message: the reused process is torn down and respawned, and the call is
        retried ONCE on a fresh helper. Access is serialized by the lock so two
        generations never interleave on one stdio channel.
        """
        with self._lock:
            try:
                yield from self._attempt(prompt, system)
            except _HelperGone:
                # The reused helper died between turns (idle-reaped by the OS,
                # crashed, or EOF). Respawn transparently and retry once so a stale
                # warm process never surfaces as a user-visible failure.
                self._teardown_locked()
                yield from self._attempt(prompt, system)
            finally:
                self._arm_idle_reaper()

    def _attempt(self, prompt: str, system: str) -> Iterator[str]:
        helper = self._ensure_started()
        try:
            yield from _stream_generate(helper, prompt, system, self._name())
        except (ChatProviderError, _HelperGone):
            raise
        except Exception as exc:  # noqa: BLE001 - any other transport error means
            # the warm helper is unusable; surface it as _HelperGone -> respawn.
            raise _HelperGone() from exc


#: Module-level registry of warm helpers keyed by ``(engine, model)``. Providers
#: are rebuilt per request by the selector (``build_selector()`` is called per
#: ``chatRequest`` / postprocess), so the warm process MUST outlive the provider
#: instance to be reused across turns — hence a process-global pool rather than a
#: per-instance field. Guarded by :data:`_pool_lock`.
_warm_helpers: dict = {}
_pool_lock = threading.Lock()


def _get_warm_helper(engine: str, model: str, factory) -> _WarmHelper:
    """Return the shared warm helper for ``(engine, model)``, creating one lazily."""
    key = (engine, model)
    with _pool_lock:
        warm = _warm_helpers.get(key)
        if warm is None:
            warm = _WarmHelper(engine, model, factory)
            _warm_helpers[key] = warm
        return warm


def shutdown_warm_helpers() -> None:
    """Tear down ALL warm helper processes now (provider close / shutdown / atexit).

    Idempotent + never raises. Registered with :mod:`atexit` so a warm helper never
    outlives the sidecar, and callable explicitly (e.g. on meeting end) to free the
    on-device model promptly.
    """
    with _pool_lock:
        warms = list(_warm_helpers.values())
        _warm_helpers.clear()
    for warm in warms:
        try:
            warm.close()
        except Exception:  # noqa: BLE001
            pass


atexit.register(shutdown_warm_helpers)


def _start_summary_session(helper: HelperProcess, engine: str, model: str, name: str) -> None:
    """Send ``summaryStart`` + wait (bounded) for ``summaryReady`` (or error)."""
    helper.send_line(json.dumps({"type": "summaryStart", "engine": engine, "model": model or None}))
    for _ in range(_MAX_LINES):
        raw = helper.read_line()
        if raw is None:
            # EOF: the (possibly reused) process is gone. Signal the pool to respawn
            # + retry rather than failing the user's message.
            raise _HelperGone()
        msg = _decode(raw)
        if msg is None:
            continue
        mtype = msg.get("type")
        if mtype == "summaryReady":
            return
        if mtype == "error":
            raise _map_error(msg, name)
        # Unrecognized line: skip (forward-compatible).
    raise ChatProviderError(
        "provider_error",
        f"The on-device {name!r} provider did not become ready.",
    )


def _stream_generate(helper: HelperProcess, prompt: str, system: str, name: str) -> Iterator[str]:
    """Send ``summaryGenerate`` + stream the answer back (module-level so both the
    warm helper and a one-shot path share one implementation).

    Yields each ``summaryToken`` delta as it arrives (so chat tokens surface
    immediately), then stops on the terminal ``summaryResult``. A helper that does
    NOT stream (only sends ``summaryResult``) still works: its full text is yielded
    once. ``system`` (the notetaker instructions) rides on its own field so the
    Swift helper can pass it to Apple Foundation Models as the session
    ``instructions`` rather than as inlined user text.
    """
    frame: dict = {"type": "summaryGenerate", "prompt": prompt}
    if system:
        frame["system"] = system
    helper.send_line(json.dumps(frame))
    streamed = False
    # Token deltas reset the stall budget, so a long streamed answer is unbounded in
    # length while a misbehaving/garbage helper is still capped.
    stalls = 0
    while stalls < _MAX_LINES:
        raw = helper.read_line()
        if raw is None:
            # EOF before a terminal result. If nothing streamed yet, the reused
            # process died before answering -> signal a respawn + retry. If deltas
            # already streamed, a retry would double-emit, so surface a plain error
            # (the already-yielded partial stands, per the streaming contract).
            if streamed:
                raise ChatProviderError(
                    "provider_error",
                    f"The on-device {name!r} provider stopped mid-answer.",
                )
            raise _HelperGone()
        msg = _decode(raw)
        if msg is None:
            stalls += 1
            continue
        mtype = msg.get("type")
        if mtype == "summaryToken":
            delta = msg.get("delta")
            if isinstance(delta, str) and delta:
                streamed = True
                stalls = 0
                yield delta
            continue
        if mtype == "summaryResult":
            # Terminal. If nothing streamed (non-streaming helper), yield the full
            # text now; if tokens already streamed, this is just the end-marker —
            # don't double-emit.
            text = msg.get("text")
            if not streamed and isinstance(text, str) and text:
                yield text
            return
        if mtype == "error":
            raise _map_error(msg, name)
        stalls += 1  # unrecognized line
    raise ChatProviderError(
        "provider_error",
        f"The on-device {name!r} provider returned no result.",
    )


def _decode(raw: str) -> Optional[dict]:
    try:
        msg = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return msg if isinstance(msg, dict) else None


def _map_error(msg: dict, name: str) -> ChatProviderError:
    code = str(msg.get("code") or "provider_error")
    message = str(msg.get("message") or "on-device summary failed")
    # Keep the helper's actionable message but never trust it as a stable code.
    return ChatProviderError("provider_error", f"{name}: {message} ({code})")


class _HelperSummaryProvider:
    """Shared base: a :class:`ChatProvider` that runs summary/chat generations
    through the Swift helper's summary protocol against a WARM (reused) helper.

    Subclasses pick the ``engine`` + the public :attr:`name`. ``helper_factory``
    is the injectable seam (the PRD-9 ``HelperProcess`` factory): production spawns
    the resolved helper binary; tests inject a fake helper scripting the protocol.
    When the factory is ``None`` (no helper — Windows / unbundled) the provider
    raises a stable, actionable :class:`ChatProviderError` so the selector's
    fallback engages — a missing helper never reaches a meeting.

    LATENCY: the underlying helper process is kept warm in a module-level pool
    (:data:`_warm_helpers`) keyed by ``(engine, model)``, so it survives across the
    per-request provider instances the selector builds. The first call spawns +
    handshakes; every later call reuses that process. An idle reaper reclaims it, so
    the one-shot summary path (which never calls :meth:`close`) never leaks a lingering
    process; :meth:`close` / :func:`shutdown_warm_helpers` free it eagerly.

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
        system, prompt = split_system_user(messages)
        # Reuse the WARM helper for this (engine, model): no cold spawn + handshake
        # per message. A dead reused helper is respawned + retried inside the pool
        # (so a stale process never fails the user's message), and the idle reaper /
        # shutdown_warm_helpers keep the process from lingering.
        warm = _get_warm_helper(self.engine, self._model, self._factory)
        try:
            yield from warm.stream_generate(prompt, system)
        except ChatProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - normalize transport errors.
            raise ChatProviderError(
                "provider_error", f"The on-device {self._name!r} provider failed."
            ) from exc

    def close(self) -> None:
        """Tear down THIS provider's warm helper now (meeting end / shutdown).

        Optional: the idle reaper already reclaims an unused helper, so the one-shot
        summary path is safe without ever calling this. Frees the on-device model
        promptly when the caller knows it's done. Never raises.
        """
        key = (self.engine, self._model)
        with _pool_lock:
            warm = _warm_helpers.pop(key, None)
        if warm is not None:
            try:
                warm.close()
            except Exception:  # noqa: BLE001
                pass


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
