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


def _silent_script(_decode_index: int, _pcm_bytes: int) -> list[AsrToken]:
    """Default script: recognize nothing (silence). Tests pass their own."""
    return []


class FakeAsrBackend:
    """Scripted, deterministic :class:`AsrBackend` (no model, no inference).

    Pass a ``script`` callable to return tokens per decode; the default returns
    no tokens. Tracks how many seconds of audio it has been handed (derived from
    the pcm byte length) so a script can position tokens on the timeline.
    """

    def __init__(self, script: Optional[FakeScript] = None, *, name: str = "fake") -> None:
        self._script: FakeScript = script or _silent_script
        self._name = name
        self._loaded = False
        #: Number of transcribe() calls so far (the script's decode index).
        self.decode_count = 0
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
    ) -> list[AsrToken]:
        index = self.decode_count
        self.decode_count += 1
        self.total_pcm_bytes += len(pcm)
        return list(self._script(index, len(pcm)))


# A static assert that FakeAsrBackend satisfies the AsrBackend protocol. Keeps
# the fake honest with the contract at import time (and documents the intent).
_check: AsrBackend = FakeAsrBackend()
_ = AUDIO_SAMPLE_WIDTH_BYTES  # keep the import meaningful for readers.
