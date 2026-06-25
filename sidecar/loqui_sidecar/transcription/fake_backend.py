"""A deterministic FAKE :class:`AsrBackend` for the hermetic unit gate.

It performs NO real inference and imports NO ML dependency — it returns scripted
tokens so the streaming pipeline, the manager, and the policy can be tested fast
and deterministically with NO model download and NO network. The real
faster-whisper backend is a separate build unit exercised only by the opt-in
real-model smoke.
"""

from __future__ import annotations

from typing import Callable, Optional

from .types import AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_WIDTH_BYTES, AsrBackend, AsrToken

#: A scripting fn: given the decode index (0-based, incremented per
#: :meth:`FakeAsrBackend.transcribe` call) and the PCM byte length, return the
#: tokens this decode should "recognize". Lets a test drive LocalAgreement-2 with
#: a controlled decode sequence (e.g. growing agreement between consecutive
#: decodes) without any audio model.
FakeScript = Callable[[int, int], list[AsrToken]]

#: A scripting fn for the accurate pass: given the decode index + PCM byte length,
#: return the ``(start, end, text)`` segments :meth:`FakeAsrBackend.transcribe_segments`
#: should "recognize" for that utterance.
FakeSegmentsScript = Callable[[int, int], list[tuple[float, float, str]]]


def _silent_script(_decode_index: int, _pcm_bytes: int) -> list[AsrToken]:
    """Default script: recognize nothing (silence). Tests pass their own."""
    return []


class FakeAsrBackend:
    """Scripted, deterministic :class:`AsrBackend` (no model, no inference).

    Pass a ``script`` callable to return tokens per decode; the default returns
    no tokens. Tracks how many seconds of audio it has been handed (derived from
    the pcm byte length) so a script can position tokens on the timeline.
    """

    def __init__(
        self,
        script: Optional[FakeScript] = None,
        *,
        name: str = "fake",
        segments_script: Optional["FakeSegmentsScript"] = None,
        detected_language: Optional[str] = None,
    ) -> None:
        self._script: FakeScript = script or _silent_script
        self._segments_script = segments_script
        self._detected_language = detected_language
        self._name = name
        self._loaded = False
        #: Number of transcribe() calls so far (the script's decode index).
        self.decode_count = 0
        #: Number of transcribe_segments() calls so far (the accurate-pass index).
        self.segment_decode_count = 0
        #: Total PCM bytes seen across all decodes (diagnostic).
        self.total_pcm_bytes = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        # No model to load; flip the flag so callers can assert load() ran.
        self._loaded = True

    def transcribe(
        self,
        pcm: bytes,
        sample_rate: int = AUDIO_SAMPLE_RATE,
        language: Optional[str] = None,
        # Accepted for protocol parity; the fake never auto-detects, so it never
        # invokes the lock sink.
        on_language: Optional[Callable[[str], None]] = None,
    ) -> list[AsrToken]:
        index = self.decode_count
        self.decode_count += 1
        self.total_pcm_bytes += len(pcm)
        return list(self._script(index, len(pcm)))

    def transcribe_segments(
        self,
        pcm: bytes,
        *,
        language: Optional[str] = None,
        beam_size: Optional[int] = None,
    ) -> "tuple[list[tuple[float, float, str]], Optional[str]]":
        """Scripted accurate-pass parity for the two-tier real-time path.

        Returns ``(segments, language)`` where each segment is
        ``(start, end, text)`` (buffer-relative seconds). Without a
        ``segments_script`` it recognizes nothing (empty), so a caller that wires
        a fake accurate backend without scripting it exercises the greedy
        fallback. The configured ``detected_language`` (or the passed
        ``language``) is echoed back.
        """
        index = self.segment_decode_count
        self.segment_decode_count += 1
        segs = list(self._segments_script(index, len(pcm))) if self._segments_script else []
        return segs, (language if language is not None else self._detected_language)


# A static assert that FakeAsrBackend satisfies the AsrBackend protocol. Keeps
# the fake honest with the contract at import time (and documents the intent).
_check: AsrBackend = FakeAsrBackend()
_ = AUDIO_SAMPLE_WIDTH_BYTES  # keep the import meaningful for readers.
