"""WhisperLive-backed live transcription pipeline (PRD-2 live engine).

Adapts the WhisperLive streaming core (:mod:`whisperlive_core`) to Loqui's
per-``(meeting, source)`` :class:`TranscriptionPipeline` contract
(``feed(DecodedFrame)`` / ``finish()``), emitting :class:`TranscriptSegment`s.

It maps WhisperLive's segment list (committed + an in-progress tail) onto Loqui's
partial/final model: each newly-COMPLETED WhisperLive segment is emitted ONCE as
a ``final`` under a stable, monotonic seg id; the in-progress tail is emitted as a
``partial`` under the NEXT-to-commit seg id (so it is superseded in place when it
later commits). On ``finish`` the last in-progress tail is flushed as a final so
the trailing words are not lost.

The faster-whisper model is reached via the injected backend's ``transcribe_raw``
(so the pipeline never constructs its own model and stays testable with a fake).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import numpy as np

from ..audio_ingest import DecodedFrame
from .types import AsrBackend, SegmentEmitter, TranscriptSegment
from .whisperlive_core import WhisperLiveTranscriber

logger = logging.getLogger("loqui_sidecar.transcription.whisperlive_pipeline")

_INT16_FULL_SCALE = 32768.0


def _seg_id(meeting_id: str, source: str, index: int) -> str:
    return f"{meeting_id}:{source}:{index}"


class _BackendModelAdapter:
    """Exposes ``.transcribe(audio, **kw) -> (segments, info)`` over an
    :class:`AsrBackend`'s ``transcribe_raw`` (faster-whisper's native shape),
    which is what :class:`WhisperLiveTranscriber` expects from a model."""

    def __init__(self, backend: AsrBackend) -> None:
        self._backend = backend

    def transcribe(self, audio, **kwargs):
        return self._backend.transcribe_raw(audio, **kwargs)  # type: ignore[attr-defined]


class WhisperLiveTranscriptionPipeline:
    """The real per-source live pipeline, powered by WhisperLive's streaming."""

    def __init__(
        self,
        meeting_id: str,
        source: str,
        emit: SegmentEmitter,
        backend: AsrBackend,
        *,
        config: Optional[Any] = None,
        language: Optional[str] = None,
    ) -> None:
        self.meeting_id = meeting_id
        self.source = source
        self._emit = emit
        self._backend = backend
        self._config = config
        self._language = language if language is not None else getattr(config, "language", None)

        self._transcriber: Optional[WhisperLiveTranscriber] = None
        self._committed_count = 0
        self._committed_keys: set = set()
        self._last_partial: Optional[tuple] = None  # (text, start, end, seg_id)
        self._finished = False

    # -- TranscriptionPipeline protocol --------------------------------------

    def feed(self, frame: DecodedFrame) -> None:
        try:
            if self._finished:
                return
            if self._transcriber is None:
                self._transcriber = WhisperLiveTranscriber(
                    _BackendModelAdapter(self._backend),
                    self._on_result,
                    language=self._language,
                )
            audio = self._pcm_to_float32(frame.pcm)
            if audio.size:
                self._transcriber.add_frames(audio)
        except Exception:  # noqa: BLE001 - transcription must never tear down ingest.
            logger.exception("whisperlive feed failed for %s/%s", self.meeting_id, self.source)

    def finish(self) -> None:
        try:
            self._finished = True
            if self._transcriber is not None:
                self._transcriber.stop()
                self._transcriber.join(timeout=5.0)
            # Flush the last in-progress tail as a final so trailing words persist.
            if self._last_partial is not None:
                text, start, end, seg_id = self._last_partial
                self._last_partial = None
                self._emit(self._make_segment(seg_id, text, start, end, "final"))
        except Exception:  # noqa: BLE001 - finish must never raise.
            logger.exception("whisperlive finish failed for %s/%s", self.meeting_id, self.source)

    # -- internals ------------------------------------------------------------

    @staticmethod
    def _pcm_to_float32(pcm: bytes) -> np.ndarray:
        usable = len(pcm) - (len(pcm) % 2)
        if usable <= 0:
            return np.empty(0, dtype=np.float32)
        samples = np.frombuffer(pcm[:usable], dtype="<i2")
        return samples.astype(np.float32) / _INT16_FULL_SCALE

    def _make_segment(self, seg_id: str, text: str, start: float, end: float, status: str) -> TranscriptSegment:
        return TranscriptSegment(
            meeting_id=self.meeting_id,
            source=self.source,
            text=text,
            t_start=max(0.0, float(start)),
            t_end=max(float(start), float(end)),
            status=status,
            seg_id=seg_id,
        )

    def _on_result(self, segments: list) -> None:
        """Map WhisperLive segments -> Loqui partial/final emissions.

        Runs on the WhisperLiveTranscriber's background thread; ``self._emit`` is
        the manager's thread-safe guarded emitter.
        """
        if self._finished:
            return
        for seg in segments:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            start = float(seg.get("start", 0.0) or 0.0)
            end = float(seg.get("end", 0.0) or 0.0)
            if seg.get("completed"):
                key = (round(start, 2), round(end, 2))
                if key in self._committed_keys:
                    continue
                self._committed_keys.add(key)
                seg_id = _seg_id(self.meeting_id, self.source, self._committed_count)
                self._committed_count += 1
                self._last_partial = None
                self._emit(self._make_segment(seg_id, text, start, end, "final"))
            else:
                # The in-progress tail -> partial under the next-to-commit slot.
                seg_id = _seg_id(self.meeting_id, self.source, self._committed_count)
                self._last_partial = (text, start, end, seg_id)
                self._emit(self._make_segment(seg_id, text, start, end, "partial"))
