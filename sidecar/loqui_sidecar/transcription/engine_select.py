"""Engine selector (PRD-9) — resolve the user's transcription engine + fallback.

Reads the ``LOQUI_TRANSCRIPTION_*`` env contract (set by the desktop main process
from the persisted ``TranscriptionSettings``; mirror of
``packages/shared/src/transcription.ts``) and returns a backend construction plan
for the chosen engine, plus a :class:`EngineSelection` describing what actually
resolved (so ``/health`` and the UI can show a fallback).

INVARIANT #4 (no engine choice ever breaks a meeting): the selector ALWAYS falls
back to faster-whisper when the chosen engine is unavailable —

  * the hermetic FAKE backend overrides everything (``LOQUI_FAKE_ASR``);
  * an unknown / default engine -> faster-whisper;
  * a macOS-native engine on a non-darwin host -> faster-whisper (note);
  * a native engine whose helper binary / capability probe is absent ->
    faster-whisper (note).

The resolved backend is NOT loaded here (the pipeline lazily loads it off the WS
hot path), so selection is cheap and a still-missing helper at load time can only
have come through the probe — which we already gate on.

The two-stream You/They model is untouched: shareable backends are constructed
once, while stateful native helpers are constructed per ``(meeting, source)``.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Callable, Optional

from .types import AsrBackend

logger = logging.getLogger("loqui_sidecar.transcription.engine_select")

#: Env contract (mirror of TRANSCRIPTION_ENV in packages/shared/src/transcription.ts).
ENGINE_ENV = "LOQUI_TRANSCRIPTION_ENGINE"
MODEL_SIZE_ENV = "LOQUI_TRANSCRIPTION_MODEL_SIZE"
LANGUAGE_ENV = "LOQUI_TRANSCRIPTION_LANGUAGE"

#: Two-tier real-time (PRD-2): the accurate FINAL backend re-decodes each
#: completed utterance with a LARGER model + beam search. Defaults to ``medium``
#: beam 5 — the same accuracy tier as the saved transcript, kept up by running
#: off the ingest thread. Set the model size to ``""``/``off``/``none`` to disable
#: (live finals fall back to the fast greedy hypothesis).
LIVE_ACCURATE_MODEL_SIZE_ENV = "LOQUI_LIVE_ACCURATE_MODEL_SIZE"
LIVE_ACCURATE_BEAM_SIZE_ENV = "LOQUI_LIVE_ACCURATE_BEAM_SIZE"
DEFAULT_LIVE_ACCURATE_MODEL_SIZE = "medium"
DEFAULT_LIVE_ACCURATE_BEAM_SIZE = 5
#: Values that explicitly DISABLE the accurate live final.
_ACCURATE_OFF_VALUES = ("off", "none", "disabled")

#: The cross-platform default + the only engine guaranteed available everywhere.
DEFAULT_ENGINE = "faster-whisper"

#: macOS-only native engines (mirror of MACOS_ONLY_ENGINES in shared).
MACOS_ONLY_ENGINES = ("apple-speech", "whisperkit", "mlx-whisper")

#: All native (helper-driven) engines.
NATIVE_ENGINES = ("apple-speech", "whisperkit", "mlx-whisper", "parakeet")

#: Known engines (anything else -> default, defensively).
KNOWN_ENGINES = (DEFAULT_ENGINE, *NATIVE_ENGINES)


@dataclass(frozen=True)
class EngineSelection:
    """What the selector resolved (for /health + the UI's fallback note)."""

    requested_engine: str
    active_engine: str
    fell_back: bool
    reason: str

    def to_status(self) -> dict:
        """camelCase status mirror of the TS ``TranscriptionStatus`` shape."""
        return {
            "requestedEngine": self.requested_engine,
            "activeEngine": self.active_engine,
            "fellBack": self.fell_back,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class BackendSelection:
    """Backend construction plan for the manager.

    ``shareable`` means the manager may build one backend and hand it to every
    per-source pipeline. Native helper backends are intentionally not shareable:
    each source needs its own helper subprocess / recognizer session.
    """

    factory: Callable[[], AsrBackend]
    shareable: bool
    engine: EngineSelection
    note: str = ""


def _is_darwin() -> bool:
    import sys

    return sys.platform == "darwin"


def _read_settings() -> tuple[str, Optional[str], Optional[str]]:
    """Read (engine, model_size, language) from the env contract (defaulted)."""
    engine = os.environ.get(ENGINE_ENV) or DEFAULT_ENGINE
    if engine not in KNOWN_ENGINES:
        engine = DEFAULT_ENGINE
    model_size = os.environ.get(MODEL_SIZE_ENV) or None
    language = os.environ.get(LANGUAGE_ENV) or None  # "" => auto-detect
    return engine, model_size, language


def resolve_engine_selection(*, helper_factory=None) -> EngineSelection:
    """Decide which engine will actually run (pure-ish; reads env + probes).

    Does NOT construct a backend — used by :func:`select_backend` and exposable to
    ``/health``. ``helper_factory`` is injected by tests to simulate the native
    helper's capability probe (and on Windows the default probe returns no engines,
    so native engines fall back).
    """
    requested, _model_size, _language = _read_settings()

    if requested == DEFAULT_ENGINE:
        return EngineSelection(requested, DEFAULT_ENGINE, False, "")

    # A native engine: it must be macOS AND the helper must report it available.
    if requested in MACOS_ONLY_ENGINES and not _is_darwin():
        import sys

        reason = f"{requested} is macOS-only — using faster-whisper on {sys.platform}"
        logger.info("transcription engine fallback: %s", reason)
        return EngineSelection(requested, DEFAULT_ENGINE, True, reason)

    from .native_backend import probe_capabilities

    available = probe_capabilities(helper_factory)
    if requested not in available:
        reason = f"{requested} unavailable (no helper / probe) — using faster-whisper"
        logger.info("transcription engine fallback: %s", reason)
        return EngineSelection(requested, DEFAULT_ENGINE, True, reason)

    return EngineSelection(requested, requested, False, "")


def _build_faster_whisper(model_size: Optional[str], language: Optional[str]) -> AsrBackend:
    from .asr_backend import FasterWhisperBackend
    from .manager import TranscriptionConfig

    cfg = TranscriptionConfig()
    return FasterWhisperBackend(
        model_size=model_size or cfg.model_size,
        device=cfg.device,
        compute_type=cfg.compute_type,
        language=language if language is not None else cfg.language,
    )


def select_backend(*, helper_factory=None) -> BackendSelection:
    """Resolve the configured engine to a backend factory (with fallback).

    * ``LOQUI_FAKE_ASR`` set -> the deterministic streaming FAKE backend (the
      hermetic gate + smoke). It overrides the engine choice entirely.
    * else resolve the engine via :func:`resolve_engine_selection`; return a
      native helper backend factory for a resolved native engine, else
      faster-whisper.

    Native helpers are returned as non-shareable factories so the manager builds
    one backend per ``(meeting, source)``. The deterministic fake and
    faster-whisper backends are shareable, preserving the single model-load
    optimization.

    A native engine that resolves but then fails to ``load()`` (e.g. the helper
    dies, or permission is revoked mid-session) is the pipeline's concern — the
    pipeline's ``_safe_transcribe`` degrades a failed decode to a dropped window,
    so even that late failure never crashes the meeting. To keep the *common*
    failure (no helper) from ever reaching a meeting, the selection above gates on
    the capability probe, so we only build a native backend the helper advertised.
    """
    # The hermetic fake overrides everything (mirrors manager._fake_asr_enabled()).
    from .manager import _fake_asr_enabled

    if _fake_asr_enabled():
        from .fake_stream import make_streaming_fake_backend

        selection = EngineSelection(DEFAULT_ENGINE, DEFAULT_ENGINE, False, "")
        return BackendSelection(make_streaming_fake_backend, True, selection)

    _requested, model_size, language = _read_settings()
    selection = resolve_engine_selection(helper_factory=helper_factory)

    if selection.active_engine == DEFAULT_ENGINE:
        return BackendSelection(
            lambda: _build_faster_whisper(model_size, language),
            True,
            selection,
            selection.reason,
        )

    # A resolved native engine. apple-speech has no selectable Whisper model size.
    from .native_backend import NativeHelperBackend

    engine_model = None if selection.active_engine == "apple-speech" else model_size

    def factory() -> AsrBackend:
        try:
            return NativeHelperBackend(
                selection.active_engine,
                model_size=engine_model,
                language=language,
                helper_factory=helper_factory,
            )
        except Exception:  # noqa: BLE001 - any construction surprise -> safe default.
            logger.warning(
                "native backend construction failed; falling back to faster-whisper",
                exc_info=True,
            )
            return _build_faster_whisper(model_size, language)

    return BackendSelection(factory, False, selection, selection.reason)


def _build_accurate_faster_whisper(model_size: str, beam_size: int) -> AsrBackend:
    from .asr_backend import FasterWhisperBackend
    from .manager import TranscriptionConfig

    cfg = TranscriptionConfig()
    # No fixed language at construction: the pipeline passes the per-stream locked
    # language (or None to auto-detect) per utterance.
    return FasterWhisperBackend(
        model_size=model_size,
        device=cfg.device,
        compute_type=cfg.compute_type,
        beam_size=beam_size,
        vad_filter=True,
    )


def select_accurate_backend() -> Optional[Callable[[], AsrBackend]]:
    """Factory for the accurate live-FINAL backend, or None to disable it.

    Returns None (so live finals stay the fast greedy hypothesis) when:

    * the hermetic FAKE backend is active (``LOQUI_FAKE_ASR``) — the gate + E2E
      must never load a real model;
    * a NATIVE engine is the active live engine — native helpers own their own
      decoding; the faster-whisper accurate pass only layers on the faster-whisper
      live path;
    * the model-size env is explicitly empty / ``off`` / ``none`` / ``disabled``.

    Otherwise returns a factory building a shared ``FasterWhisperBackend``
    (``LOQUI_LIVE_ACCURATE_MODEL_SIZE`` default ``medium``,
    ``LOQUI_LIVE_ACCURATE_BEAM_SIZE`` default 5).
    """
    from .manager import _fake_asr_enabled

    if _fake_asr_enabled():
        return None

    raw_model = os.environ.get(LIVE_ACCURATE_MODEL_SIZE_ENV)
    if raw_model is not None and raw_model.strip().lower() in ("", *_ACCURATE_OFF_VALUES):
        return None
    model_size = (raw_model or "").strip() or DEFAULT_LIVE_ACCURATE_MODEL_SIZE

    # Only layer the accurate pass on the faster-whisper live path (native engines
    # produce their own finals).
    selection = resolve_engine_selection()
    if selection.active_engine != DEFAULT_ENGINE:
        return None

    raw_beam = os.environ.get(LIVE_ACCURATE_BEAM_SIZE_ENV)
    try:
        beam_size = int(raw_beam) if raw_beam else DEFAULT_LIVE_ACCURATE_BEAM_SIZE
    except ValueError:
        beam_size = DEFAULT_LIVE_ACCURATE_BEAM_SIZE
    beam_size = max(1, beam_size)

    return lambda: _build_accurate_faster_whisper(model_size, beam_size)
