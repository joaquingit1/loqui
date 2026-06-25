"""Transcription contract types: the precise interfaces the PRD-2 build units
implement against.

Nothing here does work — these are the *shapes* and *protocols*. Keeping them in
one module (no faster-whisper / numpy import) means the manager + fake backend +
tests can import the contract without pulling the heavy ASR dependency.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, runtime_checkable

#: The WS-notification ``event`` string the engine emits (mirror of
#: ``@loqui/shared`` ``TRANSCRIPT_SEGMENT_EVENT`` / ``EVENT.transcriptSegment``).
TRANSCRIPT_SEGMENT_EVENT = "transcriptSegment"

#: Canonical capture format the pipeline receives (mirror of packages/shared).
AUDIO_SAMPLE_RATE = 16000
AUDIO_CHANNELS = 1
AUDIO_SAMPLE_WIDTH_BYTES = 2  # pcm_s16le


@dataclass(frozen=True)
class TranscriptSegment:
    """One transcript segment for one source — mirror of the TS contract
    ``@loqui/shared`` ``TranscriptSegment``.

    The sender (:func:`make_ws_emitter` in ``manager``) serializes this to the
    EXACT JSON keys the TS schema validates (``meetingId``/``tStart``/``tEnd``/
    ``segId`` — camelCase), so the field names here are snake_case and the
    serializer maps them. ``status`` is ``"partial"`` (interim, may be replaced)
    or ``"final"`` (committed; a final reuses the segId of the partials it
    supersedes). ``t_start``/``t_end`` are seconds from meeting start.
    """

    meeting_id: str
    source: str  # "mic" | "system"
    text: str
    t_start: float
    t_end: float
    status: str  # "partial" | "final"
    seg_id: str

    def to_wire(self) -> dict:
        """Serialize to the camelCase JSON the TS ``transcriptSegmentSchema`` validates."""
        return {
            "meetingId": self.meeting_id,
            "source": self.source,
            "text": self.text,
            "tStart": self.t_start,
            "tEnd": self.t_end,
            "status": self.status,
            "segId": self.seg_id,
        }


@dataclass(frozen=True)
class AsrToken:
    """One recognized token/word from an :class:`AsrBackend` decode.

    ``t_start``/``t_end`` are seconds relative to the START of the PCM buffer
    handed to :meth:`AsrBackend.transcribe` (the pipeline shifts them onto the
    meeting timeline before emitting). The streaming policy compares token
    ``text`` (and order) across consecutive decodes to find a stable prefix.
    """

    text: str
    t_start: float
    t_end: float


# --- SegmentEmitter: the pipeline -> outside-world callback signature ----------

#: The pipeline callback signature. The :class:`TranscriptionPipeline` calls this
#: exactly once per segment it produces (a ``partial`` update or a ``final``
#: commit). The manager wires this to the WS sender so each call becomes one
#: ``transcriptSegment`` notification. MUST NOT raise (the manager guards it, but
#: a raising emitter would drop that segment).
SegmentEmitter = Callable[[TranscriptSegment], None]


@runtime_checkable
class AsrBackend(Protocol):
    """Injectable ASR backend — the single seam that decouples the streaming
    pipeline from faster-whisper so the unit gate stays hermetic.

    The default gate injects :class:`~loqui_sidecar.transcription.FakeAsrBackend`
    (scripted, deterministic, no model). The real build unit provides a
    faster-whisper/CTranslate2 implementation behind a lazy import; it is
    exercised only by the opt-in real-model smoke.

    Contract:

    * :attr:`name` — short identifier surfaced in ``/health`` ``models`` (e.g.
      ``"faster-whisper:small:int8"`` or ``"fake"``).
    * :meth:`load` — idempotent; performs any one-time setup (model download/load
      for the real backend; no-op for the fake). Safe to call repeatedly.
    * :attr:`is_loaded` — True once :meth:`load` has succeeded.
    * :meth:`transcribe` — decode a single mono pcm_s16le buffer at
      ``sample_rate`` (always :data:`AUDIO_SAMPLE_RATE` in this app) and return
      tokens with buffer-relative timestamps, in time order. Deterministic for a
      given buffer (the streaming policy relies on stable repeats). MUST NOT
      mutate or retain ``pcm``.
    """

    @property
    def name(self) -> str: ...

    @property
    def is_loaded(self) -> bool: ...

    def load(self) -> None: ...

    def transcribe(
        self,
        pcm: bytes,
        sample_rate: int = AUDIO_SAMPLE_RATE,
        language: Optional[str] = None,
        # Optional sink the backend calls ONCE with a confidently auto-detected
        # language (only when ``language`` is None), so the caller can lock it.
        on_language: Optional[Callable[[str], None]] = None,
    ) -> list[AsrToken]: ...


@dataclass
class PolicyResult:
    """Output of one :meth:`StreamingPolicy.update` step.

    * ``committed`` — tokens whose prefix is now STABLE (two consecutive decodes
      agreed): the pipeline emits these as a ``final`` segment. Empty when
      nothing newly stabilized.
    * ``partial`` — the current best-guess tokens AFTER the committed prefix:
      the pipeline emits these as a ``partial`` segment (replacing the prior
      partial). Empty when there is no interim text.
    * ``committed_seconds`` — buffer-relative time up to which output is final (a
      non-decreasing watermark). It is exposed for a pipeline that wants to
      front-trim its audio buffer up to here; the current
      :class:`~loqui_sidecar.transcription.pipeline.StreamingTranscriptionPipeline`
      does NOT trim (it re-decodes the whole utterance, bounded by
      ``max_utterance_seconds``), so this is advisory.
    """

    committed: list[AsrToken] = field(default_factory=list)
    partial: list[AsrToken] = field(default_factory=list)
    committed_seconds: float = 0.0


@runtime_checkable
class StreamingPolicy(Protocol):
    """LocalAgreement-2 streaming wrapper — the trickiest correctness surface,
    kept as a pure-ish object over a *sequence of decodes* so it is unit-testable
    in isolation (PRD-2 acceptance #5: stable finals, no duplicate/overlapping
    final segIds).

    Usage per pipeline: call :meth:`update` with each fresh decode's tokens;
    it returns what is newly final vs. still partial. :meth:`flush` forces the
    remaining buffered hypothesis to ``committed`` (called at endpoint / stop).
    :meth:`reset` clears state at an utterance boundary.

    Implementations MUST guarantee: a token is committed at most once, committed
    output is monotonic (never retracted), and ``committed_seconds`` is
    non-decreasing within an utterance.
    """

    def update(self, tokens: list[AsrToken]) -> PolicyResult: ...

    def flush(self) -> PolicyResult: ...

    def reset(self) -> None: ...
