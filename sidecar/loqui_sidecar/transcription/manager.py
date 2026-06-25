"""TranscriptionManager — the :class:`~loqui_sidecar.audio_ingest.FrameConsumer`
that owns one transcription pipeline per ``(meeting_id, source)`` and emits
``TranscriptSegment`` notifications.

This is the Foundation wiring. It:

* implements the ``FrameConsumer`` protocol (``on_start`` / ``on_frame`` /
  ``on_stop``) so it can be handed to ``AudioIngest.add_consumer(...)`` — the
  PRD-1 per-(meeting,source) decoded-PCM hook;
* creates ONE pipeline per ``(meeting_id, source)`` via an injectable
  ``pipeline_factory`` so mic ("You") and system ("They") run as INDEPENDENT
  pipelines that never share buffers or policy state;
* hands each pipeline a :data:`SegmentEmitter` that the manager wires to a WS
  sender, turning every produced segment into one ``transcriptSegment``
  notification;
* guards every pipeline call so a transcription error degrades to a logged drop
  and never tears down audio ingest or the WS control channel (same robustness
  contract as :class:`~loqui_sidecar.audio_ingest.AudioIngest`).

The PRD-2 pipeline build unit provides the real ``TranscriptionPipeline``
(VAD + AsrBackend + StreamingPolicy). Foundation ships a no-op default pipeline
so wiring the manager into the running sidecar does NOT change PRD-1 behavior
(no segments are emitted until the real pipeline lands).
"""

from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Optional, Protocol

from ..audio_ingest import DecodedFrame
from .fake_backend import FakeAsrBackend
from .types import AsrBackend, SegmentEmitter, TranscriptSegment

logger = logging.getLogger("loqui_sidecar.transcription")

#: Env flag that forces the hermetic FAKE ASR backend (no model, no network, no
#: inference). Set it for the unit gate (see tests/conftest.py) and the
#: ``smoke:transcription`` harness. When UNSET, the live sidecar uses the real
#: faster-whisper backend (production default).
FAKE_ASR_ENV = "LOQUI_FAKE_ASR"


def _fake_asr_enabled() -> bool:
    val = os.environ.get(FAKE_ASR_ENV)
    return bool(val) and val not in ("0", "false", "False", "")


@dataclass
class TranscriptionConfig:
    """Engine settings (PRD-2 §"Config & performance"). Defaulted so the manager
    constructs hermetically; the real backend reads the rest.

    Defaults target CPU-only laptops. On Apple Silicon CTranslate2 has no
    Metal/MPS path, so the real backend uses ``device="cpu"`` + ``int8``.

    Measured (default ``small`` / ``int8`` on an M-series CPU, 16 kHz mono;
    to be re-measured by the real-backend build unit and recorded here):
    document RTF, added end-to-end latency, peak RSS, and the "lite" preset
    numbers in this docstring + the package README when the real backend lands.
    """

    model_size: str = "small"
    device: str = "cpu"  # "cpu" | "cuda" | "auto"
    compute_type: str = "int8"  # "int8" on CPU, "float16" on GPU
    language: Optional[str] = None  # None == auto-detect
    #: Silero VAD aggressiveness, 0..1 (higher = more aggressive gating).
    vad_aggressiveness: float = 0.5
    #: Max concurrent pipelines (mic + system = 2 by default).
    max_parallelism: int = 2


class TranscriptionPipeline(Protocol):
    """One per ``(meeting_id, source)`` streaming pipeline (the build unit
    implements this; Foundation ships :class:`_NoopPipeline`).

    Contract: ``feed`` is handed each decoded PCM frame for ITS source and may
    call its :data:`SegmentEmitter` zero or more times (partials + finals).
    ``finish`` is called on ``audioStop`` and flushes any buffered hypothesis to
    a final segment. Neither method raises (the manager guards them anyway).
    """

    def feed(self, frame: DecodedFrame) -> None: ...

    def finish(self) -> None: ...


class _NoopPipeline:
    """Foundation default pipeline: consumes frames, emits nothing.

    Keeps the manager safe to wire into the live sidecar before the real
    pipeline exists — PRD-1's WAV writing is untouched and zero
    ``transcriptSegment`` notifications are produced.
    """

    def __init__(
        self,
        meeting_id: str,
        source: str,
        emit: SegmentEmitter,
        backend: AsrBackend,
        config: TranscriptionConfig,
    ) -> None:
        self.meeting_id = meeting_id
        self.source = source
        self._emit = emit
        self._backend = backend
        self._config = config
        self.frames_fed = 0

    def feed(self, frame: DecodedFrame) -> None:
        self.frames_fed += 1

    def finish(self) -> None:
        return None


#: Factory signature the manager uses to build one pipeline per
#: ``(meeting_id, source)``. The build unit injects a factory returning the real
#: :class:`TranscriptionPipeline`; Foundation defaults to :class:`_NoopPipeline`.
PipelineFactory = Callable[
    [str, str, SegmentEmitter, AsrBackend, TranscriptionConfig],
    TranscriptionPipeline,
]


def _default_pipeline_factory(
    meeting_id: str,
    source: str,
    emit: SegmentEmitter,
    backend: AsrBackend,
    config: TranscriptionConfig,
) -> TranscriptionPipeline:
    return _NoopPipeline(meeting_id, source, emit, backend, config)


def _noop_emitter(_segment: TranscriptSegment) -> None:
    """Default emitter: drop the segment (used when no sender is wired)."""
    return None


class TranscriptionManager:
    """Per-launch transcription manager + ``FrameConsumer``.

    One instance lives on :class:`~loqui_sidecar.app.AppState`, is subscribed to
    :class:`~loqui_sidecar.audio_ingest.AudioIngest` via ``add_consumer``, and is
    handed each decoded ``(meeting_id, source)`` PCM frame. It maintains one
    pipeline per active ``(meeting_id, source)`` and routes frames to it.

    Thread-safe: a lock guards the pipeline map since the WS receive loop (and
    any future producer) can touch it concurrently — matching ``AudioIngest``.

    None of the ``FrameConsumer`` methods raise.
    """

    def __init__(
        self,
        *,
        emit: Optional[SegmentEmitter] = None,
        backend: Optional[AsrBackend] = None,
        backend_factory: Optional[Callable[[], AsrBackend]] = None,
        backend_shareable: bool = True,
        accurate_backend: Optional[AsrBackend] = None,
        accurate_backend_factory: Optional[Callable[[], AsrBackend]] = None,
        config: Optional[TranscriptionConfig] = None,
        pipeline_factory: Optional[PipelineFactory] = None,
    ) -> None:
        #: Where produced segments go. Wire :func:`make_ws_emitter` in app.py so
        #: each segment becomes one ``transcriptSegment`` WS notification.
        self._emit: SegmentEmitter = emit or _noop_emitter
        #: The ASR backend (Foundation: fake; build unit: faster-whisper).
        self._backend_shareable = backend_shareable
        if backend_factory is not None and backend_shareable:
            self._backend: AsrBackend = backend_factory()
        else:
            self._backend = backend or FakeAsrBackend()
        self._backend_factory = backend_factory
        # Two-tier real-time (PRD-2): an OPTIONAL shared accurate backend (larger
        # model + beam) used ONLY to re-decode each completed utterance into the
        # accurate FINAL. None => greedy finals (unchanged). Shared like the fast
        # backend (one model load for mic + system); each source gets its own
        # single-thread "finalizer" executor so a slow accurate decode never stalls
        # frame ingestion or the other source.
        if accurate_backend_factory is not None:
            self._accurate_backend: Optional[AsrBackend] = accurate_backend_factory()
        else:
            self._accurate_backend = accurate_backend
        self._finalizers: dict[tuple[str, str], ThreadPoolExecutor] = {}
        self._accurate_prewarmed = False
        self._config = config or TranscriptionConfig()
        self._make_pipeline: PipelineFactory = pipeline_factory or _default_pipeline_factory
        self._pipelines: dict[tuple[str, str], TranscriptionPipeline] = {}
        self._pipeline_backends: dict[tuple[str, str], AsrBackend] = {}
        self._lock = threading.Lock()
        #: Diagnostic counters (parity with AudioIngest; handy in tests).
        self.frames_seen = 0
        self.segments_emitted = 0

    # -- introspection --------------------------------------------------------

    @property
    def backend(self) -> AsrBackend:
        return self._backend

    @property
    def config(self) -> TranscriptionConfig:
        return self._config

    def set_emitter(self, emit: SegmentEmitter) -> None:
        """Set/replace the segment emitter (app.py wires the WS sender here)."""
        with self._lock:
            self._emit = emit

    # -- FrameConsumer protocol (called by AudioIngest) -----------------------

    def on_start(self, meeting_id: str, source: str) -> None:
        """Open a fresh pipeline for ``(meeting_id, source)`` (audioStart)."""
        try:
            with self._lock:
                key = (meeting_id, source)
                existing = self._pipelines.pop(key, None)
                existing_backend = self._pipeline_backends.pop(key, None)
                if existing is not None:
                    self._safe_finish(existing, existing_backend)
                backend = self._backend_for_pipeline()
                if not self._backend_shareable:
                    self._pipeline_backends[key] = backend
                pipeline = self._make_pipeline(
                    meeting_id,
                    source,
                    self._guarded_emit,
                    backend,
                    self._config,
                )
                self._pipelines[key] = pipeline
                self._attach_finalizer(key, pipeline)
            self._prewarm_accurate()
        except Exception:  # noqa: BLE001 - transcription must never raise.
            logger.exception("transcription on_start failed for %s/%s", meeting_id, source)

    def on_frame(self, meeting_id: str, source: str, frame: DecodedFrame) -> None:
        """Route one decoded frame to its ``(meeting_id, source)`` pipeline."""
        self.frames_seen += 1
        try:
            with self._lock:
                pipeline = self._pipelines.get((meeting_id, source))
            if pipeline is None:
                return  # frame before audioStart: ingest already logged the drop.
            pipeline.feed(frame)
        except Exception:  # noqa: BLE001 - transcription must never raise.
            logger.exception("transcription on_frame failed for %s/%s", meeting_id, source)

    def on_stop(self, meeting_id: str, source: str) -> None:
        """Flush + drop the ``(meeting_id, source)`` pipeline (audioStop)."""
        try:
            with self._lock:
                key = (meeting_id, source)
                pipeline = self._pipelines.pop(key, None)
                backend = self._pipeline_backends.pop(key, None)
                finalizer = self._finalizers.pop(key, None)
            if pipeline is not None:
                # finish() schedules the LAST utterance's accurate final on the
                # finalizer; draining (wait=True) AFTER ensures it is emitted +
                # persisted before the meeting tears down / post-process runs.
                self._safe_finish(pipeline, backend)
            self._drain_finalizer(finalizer)
        except Exception:  # noqa: BLE001 - transcription must never raise.
            logger.exception("transcription on_stop failed for %s/%s", meeting_id, source)

    def close(self) -> None:
        """Flush all pipelines (process-shutdown safety net)."""
        with self._lock:
            items = [
                (key, pipeline, self._pipeline_backends.get(key), self._finalizers.get(key))
                for key, pipeline in self._pipelines.items()
            ]
            self._pipelines.clear()
            self._pipeline_backends.clear()
            self._finalizers.clear()
        for _key, pipeline, backend, finalizer in items:
            self._safe_finish(pipeline, backend)
            self._drain_finalizer(finalizer)

    # -- internals ------------------------------------------------------------

    def _guarded_emit(self, segment: TranscriptSegment) -> None:
        """Emit one segment via the wired emitter; swallow+log any error."""
        try:
            self._emit(segment)
            self.segments_emitted += 1
        except Exception:  # noqa: BLE001 - one emit failure must not break the pipeline.
            logger.exception(
                "transcription emit failed for %s/%s", segment.meeting_id, segment.source
            )

    def _backend_for_pipeline(self) -> AsrBackend:
        if self._backend_shareable or self._backend_factory is None:
            return self._backend
        return self._backend_factory()

    def _attach_finalizer(self, key: tuple[str, str], pipeline: TranscriptionPipeline) -> None:
        """Give ``pipeline`` the shared accurate backend + a per-source finalizer
        executor (so accurate finals run off the ingest thread). No-op when no
        accurate backend is configured or the pipeline doesn't support it."""
        if self._accurate_backend is None:
            return
        set_finalizer = getattr(pipeline, "set_finalizer", None)
        if not callable(set_finalizer):
            return
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"finalize-{key[1]}")
        self._finalizers[key] = executor

        def schedule(task: Callable[[], None]) -> None:
            try:
                executor.submit(task)
            except RuntimeError:
                # Executor already shut down (teardown race): run inline so the
                # final is never lost.
                task()

        set_finalizer(self._accurate_backend, schedule)

    def _prewarm_accurate(self) -> None:
        """Kick the shared accurate backend's model load on a daemon thread ONCE,
        so the larger model is ready by the first utterance endpoint (mirrors the
        fast backend's off-hot-path cold-start load)."""
        if self._accurate_backend is None or self._accurate_prewarmed:
            return
        self._accurate_prewarmed = True
        load = getattr(self._accurate_backend, "load", None)
        if not callable(load):
            return

        def _load() -> None:
            try:
                load()
            except Exception:  # noqa: BLE001 - a failed pre-warm degrades to greedy finals.
                logger.warning("accurate backend pre-warm load failed", exc_info=True)

        threading.Thread(target=_load, name="accurate-prewarm", daemon=True).start()

    @staticmethod
    def _drain_finalizer(finalizer: Optional[ThreadPoolExecutor]) -> None:
        """Wait for pending accurate finals to emit, then release the executor."""
        if finalizer is None:
            return
        try:
            finalizer.shutdown(wait=True)
        except Exception:  # noqa: BLE001 - shutdown must never propagate.
            logger.exception("finalizer executor shutdown raised")

    @staticmethod
    def _safe_finish(pipeline: TranscriptionPipeline, backend: Optional[AsrBackend] = None) -> None:
        try:
            pipeline.finish()
        except Exception:  # noqa: BLE001 - finish must never propagate.
            logger.exception("transcription pipeline.finish raised")
        finally:
            if backend is not None:
                close = getattr(backend, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:  # noqa: BLE001 - close must never propagate.
                        logger.exception("transcription backend.close raised")


#: Type of the low-level WS notification sender app.py owns: ``send(event, data)``.
NotificationSender = Callable[[str, dict], None]


def make_ws_emitter(send: NotificationSender) -> SegmentEmitter:
    """Adapt a raw ``send(event, data)`` WS sender into a :data:`SegmentEmitter`.

    The returned emitter serializes each :class:`TranscriptSegment` to the exact
    camelCase wire shape the TS ``transcriptSegmentSchema`` validates and pushes
    it as a ``transcriptSegment`` notification. app.py builds ``send`` to write
    ``{"type":"notification","event":...,"data":...}`` on the live WS.
    """
    from .types import TRANSCRIPT_SEGMENT_EVENT

    def emit(segment: TranscriptSegment) -> None:
        send(TRANSCRIPT_SEGMENT_EVENT, segment.to_wire())

    return emit


def _select_backend():
    """Choose the ASR backend plan for the live sidecar (PRD-9 pluggable engines).

    Delegates to :func:`loqui_sidecar.transcription.engine_select.select_backend`,
    which:

    * forces the deterministic, source-aware streaming FAKE backend when
      ``LOQUI_FAKE_ASR`` is set (the unit gate + ``smoke:transcription`` stay
      hermetic yet exercise the real LocalAgreement-2 + pipeline path);
    * otherwise reads the ``LOQUI_TRANSCRIPTION_*`` env contract (the user's
      engine/model/language from Settings) and returns a native helper backend
      factory for a macOS on-device engine — or falls back to the real
      :class:`FasterWhisperBackend` on Windows / when the engine/helper is
      unavailable (invariant #4: no engine choice ever breaks a meeting).

    Backends are constructed but not loaded (the pipeline lazily loads off the WS
    hot path). Shareable backends (fake / faster-whisper) are constructed once;
    native helpers are constructed per ``(meeting, source)`` so mic and system do
    not share a stateful recognizer session.
    """
    from .engine_select import select_backend

    return select_backend()


def default_transcription_manager() -> TranscriptionManager:
    """Construct the live transcription manager (REAL streaming pipeline).

    Wires the real per-``(meeting, source)`` :class:`StreamingTranscriptionPipeline`
    (VAD endpointing -> :class:`AsrBackend` -> LocalAgreement-2 policy) via
    :func:`make_pipeline_factory`, so the live path actually USES the streaming
    policy + the injectable ASR interface — no dead/bypassed code.

    The backend is chosen by :func:`_select_backend`: the hermetic streaming FAKE
    when ``LOQUI_FAKE_ASR`` is set (unit gate + smoke), else the real
    faster-whisper backend (production). The emitter starts inert (no live WS);
    ``app.py`` wires :func:`make_ws_emitter` to the live socket on connect, so
    until a renderer connects no ``transcriptSegment`` notification is sent — but
    the moment a socket is up, real partial/final segments flow.
    """
    from .engine_select import select_accurate_backend
    from .pipeline import make_pipeline_factory

    backend_selection = _select_backend()
    accurate_factory = select_accurate_backend()
    return TranscriptionManager(
        backend_factory=backend_selection.factory,
        backend_shareable=backend_selection.shareable,
        accurate_backend_factory=accurate_factory,
        pipeline_factory=make_pipeline_factory(),
    )
