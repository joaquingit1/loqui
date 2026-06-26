"""Real ASR backend over faster-whisper / CTranslate2 (PRD-2 build unit).

This module provides :class:`FasterWhisperBackend`, the production
:class:`~loqui_sidecar.transcription.types.AsrBackend`. It is imported ONLY by
the real pipeline + the opt-in real-model smoke
(``tests/test_asr_real_model.py``, gated on ``LOQUI_RUN_ASR_TESTS``) — never by
the default hermetic unit gate, which uses
:class:`~loqui_sidecar.transcription.FakeAsrBackend`.

Key properties:

* **Lazy, idempotent model load.** ``faster_whisper`` is imported and the model
  is constructed inside :meth:`FasterWhisperBackend.load` (and lazily on first
  :meth:`transcribe`), so merely importing this module costs nothing and pulls
  in no model. CTranslate2 has no Metal/MPS path, so on Apple Silicon use
  ``device="cpu"`` + ``compute_type="int8"`` (the defaults).
* **Self-contained model cache.** Models download on first use into
  ``<dataRoot>/models`` (``LOQUI_DATA_DIR`` honored), so the app is offline after
  the first successful load and never writes to the user's global HF cache.
* **Status surface for /health.** :attr:`FasterWhisperBackend.status` returns a
  small dict (``name`` / ``state`` / ``model_size`` / ``device`` /
  ``compute_type`` / ``error``) that ``app.py`` can fold into the ``models`` map.
* **Deterministic, non-retaining transcribe.** ``transcribe`` decodes one
  ``pcm_s16le`` buffer to timed :class:`AsrToken` (word timestamps, buffer
  relative) and never mutates/retains the input — LocalAgreement-2 relies on
  stable repeats across consecutive decodes, so greedy decoding (``beam_size=1``,
  no temperature fallback) is used for repeatability.

Measured latency / CPU (default ``small`` / ``int8``, 16 kHz mono — fill in on
real hardware; see ``README.md``): on an Apple-silicon CPU the ``small`` model
runs comfortably below real time (RTF < 1) for short utterance windows; the
``tiny`` "lite" preset is markedly faster for weak machines. Both pipelines
(mic + system) sharing one process stay within budget because each decode acts
on a short VAD-cut window, not the whole stream.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any, Callable, List, Optional

from .types import AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_WIDTH_BYTES, AsrBackend, AsrToken

logger = logging.getLogger("loqui_sidecar.transcription.asr")

#: Data-root layout (mirror of audio_ingest / packages/shared constants).
_DATA_DIR_ENV = "LOQUI_DATA_DIR"
_DEFAULT_DATA_DIR_NAME = "Loqui"
#: Models cache directory name under the data root (``<dataRoot>/models``).
MODELS_DIR_NAME = "models"

#: Full-scale magnitude of a signed 16-bit PCM sample.
_INT16_FULL_SCALE = 32768.0

#: Minimum language-detection probability before we LOCK the stream's language
#: (below this we keep auto-detecting; above it we trust + pin the detection).
_LANGUAGE_LOCK_MIN_PROB = 0.5

#: Progress callback: ``(stage: str, detail: dict) -> None``. Stages are
#: ``"download"`` (model fetch begins) / ``"load"`` (model construction) /
#: ``"ready"`` (loaded). Never required; defaulted to a no-op.
ProgressCallback = Callable[[str, dict], None]


def _resolve_models_dir(explicit: Optional[Path] = None) -> Path:
    """``<dataRoot>/models`` (``LOQUI_DATA_DIR`` honored), or an explicit dir."""
    if explicit is not None:
        return explicit
    override = os.environ.get(_DATA_DIR_ENV)
    root = Path(override) if override else (Path.home() / _DEFAULT_DATA_DIR_NAME)
    return root / MODELS_DIR_NAME


def _noop_progress(_stage: str, _detail: dict) -> None:
    return None


def _pcm_to_float32(pcm: bytes):
    """Convert mono ``pcm_s16le`` bytes to a float32 numpy array in [-1, 1).

    numpy is a declared dependency (used only by the real backend); imported
    lazily so this module is import-cheap and the hermetic gate never needs it.
    """
    import numpy as np

    usable = len(pcm) - (len(pcm) % AUDIO_SAMPLE_WIDTH_BYTES)
    samples = np.frombuffer(pcm[:usable], dtype="<i2")
    # Copy + scale; never mutate/retain the caller's bytes.
    return samples.astype(np.float32) / _INT16_FULL_SCALE


class FasterWhisperBackend:
    """faster-whisper / CTranslate2 :class:`AsrBackend` (real inference).

    Construct with ``model_size`` (default ``"small"``; ``"tiny"`` for the "lite"
    preset), ``device`` (``"cpu"`` default; ``"auto"`` lets CTranslate2 pick),
    and ``compute_type`` (``"int8"`` on CPU). ``vad_filter`` toggles
    faster-whisper's own Silero gate on the decode input (additive to our
    streaming VAD endpointer). The model loads lazily + idempotently; failures
    are surfaced via :attr:`status` (``state="error"``) and re-raised from
    :meth:`load` so callers can decide.
    """

    def __init__(
        self,
        model_size: str = "small",
        *,
        device: str = "cpu",
        compute_type: str = "int8",
        language: Optional[str] = None,
        # ON by default: faster-whisper's built-in Silero VAD drops non-speech
        # BEFORE decoding, which is what kills the silence/noise hallucinations
        # (random text in random languages on quiet windows). The decoder's
        # hallucination guards (no_speech/log_prob/compression thresholds) are
        # already applied via faster-whisper's defaults.
        vad_filter: bool = True,
        models_dir: Optional[Path] = None,
        download_root: Optional[str] = None,
        cpu_threads: int = 0,
        progress: Optional[ProgressCallback] = None,
        beam_size: int = 1,
    ) -> None:
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._language = language
        self._vad_filter = vad_filter
        # Resolve where models cache. download_root (a raw str) wins if given.
        if download_root is not None:
            self._download_root = download_root
        else:
            self._download_root = str(_resolve_models_dir(models_dir))
        self._cpu_threads = cpu_threads
        self._beam_size = beam_size
        self._progress: ProgressCallback = progress or _noop_progress
        self._model: Any = None
        self._loaded = False
        self._error: Optional[str] = None
        # Guards model construction so a SHARED backend (mic + system pipelines
        # each kick a load thread at cold start) builds the WhisperModel exactly
        # once — the bare ``if self._loaded`` check is not atomic.
        self._load_lock = threading.Lock()

    # -- AsrBackend protocol --------------------------------------------------

    @property
    def name(self) -> str:
        return f"faster-whisper:{self._model_size}:{self._compute_type}"

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        """Idempotently import faster-whisper + construct the model.

        First call downloads the model into ``<dataRoot>/models`` (offline after
        that). Emits ``download`` / ``load`` / ``ready`` progress. Re-raises on
        failure after recording it in :attr:`status`.

        Concurrency-safe: when mic + system pipelines share one backend they each
        spawn a load thread at cold start; the lock + double-check below ensure
        the heavy ``WhisperModel`` is constructed exactly once (a second thread
        sees ``_loaded`` and returns rather than building a second model).
        """
        if self._loaded:
            return
        with self._load_lock:
            # Double-check under the lock: a sibling thread may have finished the
            # load while we waited to acquire it.
            if self._loaded:
                return
            try:
                # Lazy heavy import: keeps the unit gate offline + import-cheap.
                from faster_whisper import WhisperModel  # type: ignore[import-not-found]

                Path(self._download_root).mkdir(parents=True, exist_ok=True)
                self._progress(
                    "download",
                    {"model_size": self._model_size, "download_root": self._download_root},
                )
                self._progress(
                    "load",
                    {"device": self._device, "compute_type": self._compute_type},
                )
                kwargs: dict[str, Any] = {
                    "device": self._device,
                    "compute_type": self._compute_type,
                    "download_root": self._download_root,
                }
                if self._cpu_threads:
                    kwargs["cpu_threads"] = self._cpu_threads
                self._model = WhisperModel(self._model_size, **kwargs)
                self._loaded = True
                self._error = None
                self._progress("ready", {"name": self.name})
            except Exception as exc:  # noqa: BLE001 - surface, record, re-raise.
                self._error = f"{type(exc).__name__}: {exc}"
                logger.warning("FasterWhisperBackend load failed: %s", self._error)
                raise

    def transcribe(
        self,
        pcm: bytes,
        sample_rate: int = AUDIO_SAMPLE_RATE,
        language: Optional[str] = None,
        on_language: Optional[Callable[[str], None]] = None,
    ) -> List[AsrToken]:
        """Decode one ``pcm_s16le`` buffer to time-ordered word tokens.

        Buffer-relative word timestamps. Greedy + repeatable so LocalAgreement-2
        sees stable repeats. Resamples nothing — the app feeds 16 kHz; a
        different ``sample_rate`` is honored by passing the float array straight
        to faster-whisper (which expects 16 kHz, so callers should resample
        upstream). Does NOT mutate or retain ``pcm``.
        """
        if not self._loaded:
            self.load()
        audio = _pcm_to_float32(pcm)
        if audio.size == 0:
            return []
        lang = language if language is not None else self._language
        segments, info = self._model.transcribe(
            audio,
            language=lang,
            beam_size=self._beam_size,
            temperature=0.0,
            word_timestamps=True,
            vad_filter=self._vad_filter,
            condition_on_previous_text=False,
        )
        # If we auto-detected (no language pinned), report a confident detection
        # so the caller can LOCK it — this stops per-window re-detection from
        # flip-flopping between languages (e.g. English/Spanish) mid-stream.
        if on_language is not None and lang is None:
            detected = getattr(info, "language", None)
            prob = float(getattr(info, "language_probability", 0.0) or 0.0)
            if detected and prob >= _LANGUAGE_LOCK_MIN_PROB:
                on_language(detected)
        tokens: List[AsrToken] = []
        for seg in segments:
            words = getattr(seg, "words", None)
            if words:
                for w in words:
                    text = (w.word or "").strip()
                    if not text:
                        continue
                    tokens.append(AsrToken(text=text, t_start=float(w.start), t_end=float(w.end)))
            else:
                # No word timestamps (some models/segments): fall back to the
                # segment as a single token spanning its own time range.
                text = (seg.text or "").strip()
                if text:
                    tokens.append(
                        AsrToken(text=text, t_start=float(seg.start), t_end=float(seg.end))
                    )
        return tokens

    def transcribe_segments(
        self,
        pcm: bytes,
        *,
        language: Optional[str] = None,
        beam_size: Optional[int] = None,
    ) -> "tuple[list[tuple[float, float, str]], Optional[str]]":
        """Batch-decode a WHOLE recording to sentence-level ``(start, end, text)``.

        Unlike the streaming :meth:`transcribe` (greedy, word tokens, no prior
        context — tuned for LocalAgreement-2 repeatability), this is the
        high-accuracy OFFLINE pass for the saved transcript: it feeds the entire
        audio at once and lets faster-whisper segment it, with beam search,
        ``condition_on_previous_text=True`` (cross-segment coherence) and its
        Silero VAD. ``language=None`` auto-detects ONCE over the full audio (far
        more reliable than the per-window live detection). Returns the segments
        plus the language faster-whisper used. Does NOT mutate/retain ``pcm``.
        """
        if not self._loaded:
            self.load()
        audio = _pcm_to_float32(pcm)
        if audio.size == 0:
            return [], language
        lang = language if language is not None else self._language
        segments, info = self._model.transcribe(
            audio,
            language=lang,
            beam_size=beam_size if beam_size is not None else max(self._beam_size, 5),
            temperature=0.0,
            word_timestamps=False,
            vad_filter=self._vad_filter,
            condition_on_previous_text=True,
        )
        out: list[tuple[float, float, str]] = []
        for seg in segments:
            text = (seg.text or "").strip()
            if text:
                out.append((float(seg.start), float(seg.end), text))
        detected = lang or getattr(info, "language", None)
        return out, detected

    def transcribe_raw(
        self,
        audio,
        *,
        language: Optional[str] = None,
        task: str = "transcribe",
        vad_filter: Optional[bool] = None,
        vad_parameters: Optional[dict] = None,
        initial_prompt: Optional[str] = None,
    ):
        """Raw faster-whisper ``transcribe`` returning ``(segments, info)``.

        The seam the WhisperLive live pipeline drives: ``audio`` is a float32
        numpy array (16 kHz mono), and the return is faster-whisper's native
        ``(segments_iterable, TranscriptionInfo)``. Greedy + repeatable
        (``beam_size`` from construction, no temperature fallback) for low live
        latency; uses faster-whisper's built-in Silero ``vad_filter``.
        """
        if not self._loaded:
            self.load()
        return self._model.transcribe(
            audio,
            language=language if language is not None else self._language,
            task=task,
            beam_size=self._beam_size,
            temperature=0.0,
            vad_filter=self._vad_filter if vad_filter is None else vad_filter,
            vad_parameters=vad_parameters,
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
            word_timestamps=False,
        )

    # -- /health surface ------------------------------------------------------

    @property
    def status(self) -> dict:
        """Small status dict for ``app.py`` to fold into ``/health`` ``models``."""
        if self._loaded:
            state = "loaded"
        elif self._error is not None:
            state = "error"
        else:
            state = "unloaded"
        return {
            "name": self.name,
            "state": state,
            "model_size": self._model_size,
            "device": self._device,
            "compute_type": self._compute_type,
            "error": self._error,
        }


# Static conformance check: FasterWhisperBackend satisfies the AsrBackend
# protocol (no model load — construction is cheap + import-light).
_check: AsrBackend = FasterWhisperBackend()
