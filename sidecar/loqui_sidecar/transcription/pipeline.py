"""Per-``(meeting, source)`` streaming transcription pipeline (PRD-2 build unit
"pipeline-orchestration").

One :class:`StreamingTranscriptionPipeline` instance owns the streaming wrapper
for ONE source ("mic" = "You" / "system" = "They"). It is fed decoded PCM frames
by the :class:`~loqui_sidecar.transcription.manager.TranscriptionManager` and:

#. **buffers** the per-source pcm_s16le into a bounded utterance buffer;
#. uses a **VAD endpointer** to detect speech vs. silence and cut utterances at
   a trailing silence (endpoint);
#. runs the injected :class:`~loqui_sidecar.transcription.types.AsrBackend` on
   **overlapping windows** of the live utterance buffer (re-decoding a growing
   buffer so LocalAgreement-2 sees stable repeats);
#. feeds each decode's tokens to the :class:`StreamingPolicy`
   (LocalAgreement-2), which commits a stable prefix as ``final`` and exposes the
   remaining hypothesis as ``partial``;
#. emits :class:`~loqui_sidecar.transcription.types.TranscriptSegment` via its
   :data:`SegmentEmitter` — one ``partial`` updating in place (stable
   ``seg_id``), then a ``final`` committing that ``seg_id`` and rolling to the
   next.

Timestamps are tracked on the **meeting timeline** (seconds from meeting start),
derived from the first frame's ``captureTimestampMs`` plus the per-source sample
count, so a segment's ``t_start``/``t_end`` are absolute meeting offsets — never
buffer-relative (the backend returns buffer-relative; the pipeline shifts).

INDEPENDENCE: this object holds NO module/global state; the manager creates one
per ``(meeting, source)``, so mic and system never share a buffer or policy.

BACKPRESSURE (documented + bounded): ASR may be slower than realtime. The
pipeline NEVER grows its utterance buffer without bound:

* a decode runs at most once per ``decode_interval_seconds`` of newly-buffered
  audio (windowed, not per-frame), so a fast frame rate cannot queue unbounded
  work;
* if buffered audio exceeds ``max_utterance_seconds`` without an endpoint, the
  pipeline **force-commits** the current hypothesis (a synthetic endpoint) and
  clears the buffer, so the live buffer is capped regardless of speech.

The utterance buffer holds the WHOLE current utterance (it is NOT front-trimmed
on each commit): every windowed decode re-transcribes the entire growing
utterance buffer, so per-utterance backend work grows with utterance length up
to the ``max_utterance_seconds`` cap (re-decoding the committed prefix is what
lets LocalAgreement-2 see stable repeats, and keeps committed-token timestamps
correct without re-basing). The policy returns ``committed_seconds`` as a
watermark, but this pipeline does not currently slice the buffer to it. The cost
is bounded by the 30s cap and kept off the WS control channel because the decode
runs on a per-source worker thread (see ``app.py`` ``_dispatch_binary_frame``),
not the event loop, so a long monologue's larger decodes never stall control or
the other source's ingest.

This module is HERMETIC by default: it imports only the contract types + numpy
(declared, installed), ships its own :class:`EnergyVad`, and re-uses the single
:class:`~loqui_sidecar.transcription.streaming.LocalAgreementPolicy` (the
exhaustively-tested policy in ``streaming.py``) so it is unit-testable with the
FAKE backend and NO model. Both are injectable via :class:`PipelineConfig` so the
dedicated ``vad`` build unit can slot its implementation in without touching this
file, and the live path runs the same policy the policy gate exercises (no
duplicate/divergent reimplementation).
"""

from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, runtime_checkable

from ..audio_ingest import (
    AUDIO_SAMPLE_RATE,
    AUDIO_SAMPLE_WIDTH_BYTES,
    DecodedFrame,
)
from .streaming import LocalAgreementPolicy
from .types import (
    AsrBackend,
    AsrToken,
    SegmentEmitter,
    StreamingPolicy,
    TranscriptSegment,
)

logger = logging.getLogger("loqui_sidecar.transcription.pipeline")

#: How long the pipeline will WAIT for the backend's ``load()`` before letting it
#: continue in the background. A fast/no-op load (the FAKE backend) finishes well
#: within this, keeping the hermetic path synchronous + deterministic; the real
#: faster-whisper load overruns it and proceeds off the WS hot path.
_BACKEND_LOAD_GRACE_SECONDS = 0.25


# --- VAD endpointer seam ------------------------------------------------------


@runtime_checkable
class VadEndpointer(Protocol):
    """Voice-activity endpointer: decides, frame by frame, whether the source is
    currently speaking and whether a trailing silence has ended the utterance.

    Pure + stateful per source. The default :class:`EnergyVad` is a
    dependency-free RMS gate that keeps the pipeline + its gate hermetic.

    ``accept`` returns ``(is_speech, endpoint)``: ``is_speech`` is whether THIS
    chunk carries voice; ``endpoint`` is True exactly when enough trailing
    silence has accrued to close the current utterance (it has been speaking and
    just went quiet for the hangover window).

    Integrating the ``vad`` build unit: its ``StreamingVad`` exposes a
    *segment-oriented* API (``feed(pcm) -> list[SpeechSegment]``), a DIFFERENT
    shape from this frame endpointer. Slot it in by passing a ``vad_factory``
    that returns a thin adapter mapping ``StreamingVad`` onto ``accept`` (a chunk
    that yields/extends a segment is speech; a chunk that closes one is an
    endpoint). The pipeline only ever calls ``accept`` / ``reset`` — keeping that
    adapter outside this module preserves the hermetic gate.
    """

    def accept(self, pcm: bytes) -> tuple[bool, bool]: ...

    def reset(self) -> None: ...


class EnergyVad:
    """Dependency-free RMS energy VAD endpointer (hermetic default).

    A chunk counts as speech when its RMS amplitude exceeds ``threshold`` (on the
    pcm_s16le full-scale 0..1 range). An endpoint fires once we have observed
    speech and then accumulated ``hangover_seconds`` of continuous silence — the
    classic "speech then trailing silence" utterance boundary.

    Deterministic; holds only the small running state needed for endpointing.
    """

    def __init__(
        self,
        *,
        threshold: float = 0.012,
        hangover_seconds: float = 0.6,
        sample_rate: int = AUDIO_SAMPLE_RATE,
    ) -> None:
        self._threshold = threshold
        self._hangover_seconds = hangover_seconds
        self._sample_rate = sample_rate
        self._has_spoken = False
        self._silence_seconds = 0.0

    @staticmethod
    def _rms(pcm: bytes) -> float:
        usable = len(pcm) - (len(pcm) % AUDIO_SAMPLE_WIDTH_BYTES)
        if usable <= 0:
            return 0.0
        # int.from_bytes per-sample is slow; numpy is declared + installed, but
        # keep a pure path so VAD never hard-requires it. Use numpy when present.
        try:
            import numpy as np

            arr = np.frombuffer(pcm[:usable], dtype="<i2").astype("float32")
            if arr.size == 0:
                return 0.0
            return float(np.sqrt(np.mean((arr / 32768.0) ** 2)))
        except Exception:  # noqa: BLE001 - fall back to a pure-python RMS.
            total = 0.0
            count = usable // AUDIO_SAMPLE_WIDTH_BYTES
            for i in range(0, usable, AUDIO_SAMPLE_WIDTH_BYTES):
                sample = int.from_bytes(pcm[i : i + 2], "little", signed=True)
                total += (sample / 32768.0) ** 2
            return math.sqrt(total / count) if count else 0.0

    def accept(self, pcm: bytes) -> tuple[bool, bool]:
        usable = len(pcm) - (len(pcm) % AUDIO_SAMPLE_WIDTH_BYTES)
        seconds = (usable // AUDIO_SAMPLE_WIDTH_BYTES) / float(self._sample_rate)
        is_speech = self._rms(pcm) >= self._threshold
        endpoint = False
        if is_speech:
            self._has_spoken = True
            self._silence_seconds = 0.0
        else:
            self._silence_seconds += seconds
            if self._has_spoken and self._silence_seconds >= self._hangover_seconds:
                endpoint = True
                # Re-arm: the next speech starts a new utterance.
                self._has_spoken = False
                self._silence_seconds = 0.0
        return is_speech, endpoint

    def reset(self) -> None:
        self._has_spoken = False
        self._silence_seconds = 0.0


# --- LocalAgreement-2 policy (hermetic default) -------------------------------

# The LocalAgreement-2 policy is implemented ONCE, in ``streaming.py`` (imported
# at the top of this module) — the exhaustively-tested (test_streaming_policy.py),
# robust version that strips the committed prefix by matching committed text in
# order (so a real-backend decode that shifts/inserts a leading word can never
# re-commit an already-committed token) and normalizes case/trailing punctuation
# for agreement (so two decodes that differ only cosmetically still stabilize on
# agreement instead of waiting for the endpoint flush). The live path
# (``policy_factory`` below -> ``make_pipeline_factory`` ->
# ``default_transcription_manager`` -> ``app.py``) uses THIS class, so production
# runs the same policy the gate exercises — no second, divergent reimplementation.
# ``LocalAgreementPolicy`` is re-exported from this module so ``policy_factory``
# and existing ``from .pipeline import LocalAgreementPolicy`` imports keep working.

# --- pipeline config ----------------------------------------------------------

PolicyFactory = Callable[[], StreamingPolicy]
VadFactory = Callable[[], VadEndpointer]


@dataclass
class PipelineConfig:
    """Streaming knobs for :class:`StreamingTranscriptionPipeline`.

    Defaulted so the pipeline constructs hermetically. The ``vad`` /
    ``streaming_policy`` build units inject their implementations via
    ``vad_factory`` / ``policy_factory`` without editing this module.

    Backpressure caps (see module docstring): ``decode_interval_seconds`` limits
    how often ASR runs (windowed), ``max_utterance_seconds`` force-endpoints a
    runaway utterance so the live buffer can never grow without bound.

    Latency budget (orchestration overhead only — backend decode cost is the
    real backend's to measure + record in the package README): the soonest a
    ``partial`` can appear is ``decode_interval_seconds`` after speech onset (one
    decode window); a ``final`` appears at the VAD endpoint
    (``EnergyVad.hangover_seconds`` of trailing silence after speech) or on
    ``finish``. Lowering ``decode_interval_seconds`` cuts partial latency but
    runs the backend more often (more CPU). With the FAKE backend the pipeline
    itself is sub-millisecond per frame; the dominant cost in production is the
    backend's real-time factor (RTF), to be documented by the real-backend unit.
    """

    sample_rate: int = AUDIO_SAMPLE_RATE
    language: Optional[str] = None
    #: Run an ASR decode after at least this much NEW audio has buffered.
    decode_interval_seconds: float = 0.5
    #: Don't decode a window shorter than this (avoids noise on a sliver).
    min_decode_seconds: float = 0.2
    #: Hard cap on un-committed buffered audio; exceeding it force-commits.
    max_utterance_seconds: float = 30.0
    #: Injected endpointer / policy factories (default to the hermetic ones).
    vad_factory: VadFactory = field(default=EnergyVad)
    policy_factory: PolicyFactory = field(default=LocalAgreementPolicy)


def _seg_id(meeting_id: str, source: str, index: int) -> str:
    """Stable, unique-per-utterance segment id (never empty)."""
    return f"{meeting_id}:{source}:{index}"


class StreamingTranscriptionPipeline:
    """The real per-``(meeting, source)`` :class:`TranscriptionPipeline`.

    Construction matches :data:`PipelineFactory`
    ``(meeting_id, source, emit, backend, transcription_config)``; the streaming
    knobs come from a :class:`PipelineConfig` captured by the factory (see
    :func:`make_pipeline_factory`).

    ``feed`` / ``finish`` NEVER raise — the manager guards them anyway, but a
    decode error degrades to a logged drop so audio ingest is never torn down.
    """

    def __init__(
        self,
        meeting_id: str,
        source: str,
        emit: SegmentEmitter,
        backend: AsrBackend,
        *,
        config: Optional[PipelineConfig] = None,
        language: Optional[str] = None,
    ) -> None:
        self.meeting_id = meeting_id
        self.source = source
        self._emit = emit
        self._backend = backend
        self._config = config or PipelineConfig()
        # Per-pipeline language: explicit arg > config.language.
        self._language = language if language is not None else self._config.language

        self._vad: VadEndpointer = self._config.vad_factory()
        self._policy: StreamingPolicy = self._config.policy_factory()

        bytes_per_sample = AUDIO_SAMPLE_WIDTH_BYTES
        self._bytes_per_second = self._config.sample_rate * bytes_per_sample

        # Live (un-finalized) utterance PCM buffer.
        self._buf = bytearray()
        # Meeting-timeline second at which _buf[0] begins. Set on the first
        # buffered frame of the utterance and held until the utterance resets (the
        # buffer is not front-trimmed, so this base stays fixed for the utterance).
        self._buf_start_seconds: Optional[float] = None
        # First frame's capture offset, so timestamps are meeting-absolute.
        self._meeting_origin_ms: Optional[float] = None
        # Bytes appended since the last decode (windowing / backpressure gate).
        self._undecoded_bytes = 0
        # Whether a backend decode has succeeded for the current utterance.
        self._decoded_once = False
        # Whether the VAD has reported speech in the current utterance. We do not
        # decode (or keep) pure-silence buffers: leading silence is trimmed and an
        # all-silence stretch never reaches the backend.
        self._speech_seen = False

        # Monotonic utterance index -> stable, non-overlapping seg ids. ONE id
        # per utterance; partials update in place under it, the final commits it.
        self._utterance_index = 0
        # Whether any text has been emitted for the CURRENT utterance (so an
        # endpoint with no committed tail still commits a final under its id).
        self._emitted_current = False
        # The committed (stable) tokens so far for the current utterance. A
        # ``partial`` shows committed-prefix + interim; the ``final`` shows the
        # committed text. Kept here so partial/final share the utterance segId.
        self._committed_tokens: list[AsrToken] = []

        # Backend load runs OFF the audio/WS hot path. The real
        # ``FasterWhisperBackend.load()`` imports faster-whisper + may download a
        # model — doing that synchronously here would block the WS control
        # channel (audio ingest is driven from the WS receive call stack), which
        # would break the PRD-0/PRD-1 responsiveness contract. So we kick the
        # load onto a daemon thread (idempotent) and simply BUFFER audio until
        # the backend reports loaded; decodes are skipped (not queued) until then.
        self._backend_load_started = False
        self._start_backend_load()

    # -- TranscriptionPipeline protocol --------------------------------------

    def feed(self, frame: DecodedFrame) -> None:
        try:
            self._feed(frame)
        except Exception:  # noqa: BLE001 - a decode error must never propagate.
            logger.exception(
                "transcription pipeline feed failed for %s/%s", self.meeting_id, self.source
            )

    def finish(self) -> None:
        try:
            self._endpoint(force_flush=True)
        except Exception:  # noqa: BLE001 - finish must never propagate.
            logger.exception(
                "transcription pipeline finish failed for %s/%s", self.meeting_id, self.source
            )

    # -- internals ------------------------------------------------------------

    def _start_backend_load(self) -> None:
        """Begin loading the backend off the hot path (idempotent, non-blocking).

        If the backend is already loaded (e.g. the fake backend, or a shared real
        backend a sibling pipeline already loaded), there is nothing to do — we
        never spawn a thread. Otherwise a single daemon thread runs ``load()``;
        ``feed`` keeps buffering meanwhile and ``_backend_ready`` gates decodes.
        """
        if self._backend_load_started:
            return
        self._backend_load_started = True
        try:
            if self._backend.is_loaded:
                return
        except Exception:  # noqa: BLE001 - a flaky property must not break feed.
            pass

        def _load() -> None:
            try:
                self._backend.load()
            except Exception:  # noqa: BLE001 - a load failure degrades to silence.
                logger.exception("ASR backend load failed for %s/%s", self.meeting_id, self.source)

        thread = threading.Thread(
            target=_load,
            name=f"asr-load-{self.source}",
            daemon=True,
        )
        thread.start()
        # Join briefly: a CHEAP backend (the FAKE backend's no-op load) completes
        # within the grace window, so the common/hermetic case stays synchronous
        # + race-free (the first decode sees a ready backend). A SLOW real load
        # (faster-whisper import + model download) overruns the window and keeps
        # loading in the background, so the WS control channel is never blocked.
        thread.join(timeout=_BACKEND_LOAD_GRACE_SECONDS)

    def _backend_ready(self) -> bool:
        try:
            return bool(self._backend.is_loaded)
        except Exception:  # noqa: BLE001 - treat a flaky backend as not-ready.
            return False

    def _feed(self, frame: DecodedFrame) -> None:
        pcm = frame.pcm
        # Keep the buffer 16-bit aligned (a ragged byte would desync timestamps).
        usable = len(pcm) - (len(pcm) % AUDIO_SAMPLE_WIDTH_BYTES)
        if usable <= 0:
            return
        pcm = pcm[:usable]

        if self._meeting_origin_ms is None:
            # Anchor the meeting timeline to the first frame we ever see for this
            # source so t_start/t_end are seconds from (this source's) first audio.
            self._meeting_origin_ms = frame.timestamp_ms

        is_speech, endpoint = self._vad.accept(pcm)

        # Drop leading silence: until the utterance has any speech, don't buffer
        # (or decode) silence — keeps the buffer small and timestamps tight, and
        # means an idle source never reaches the backend at all.
        if not self._speech_seen and not is_speech:
            return

        if is_speech:
            self._speech_seen = True

        if self._buf_start_seconds is None:
            self._buf_start_seconds = self._frame_offset_seconds(frame)

        self._buf.extend(pcm)
        self._undecoded_bytes += len(pcm)

        # Backpressure: cap the live buffer regardless of endpointing. If a
        # runaway utterance never goes silent, force an endpoint + reset so the
        # live buffer can never grow past ``max_utterance_seconds``.
        if self._buffered_seconds() >= self._config.max_utterance_seconds:
            logger.warning(
                "transcription %s/%s: utterance exceeded %.1fs without endpoint; "
                "force-committing (backpressure)",
                self.meeting_id,
                self.source,
                self._config.max_utterance_seconds,
            )
            self._endpoint(force_flush=True)
            return

        if endpoint:
            self._endpoint(force_flush=True)
            return

        # Windowed decode: only run ASR once enough new audio has accrued, so a
        # fast frame rate cannot queue unbounded backend work. Skip while the
        # backend is still loading (keep buffering; the cap above bounds growth).
        decode_interval_bytes = int(self._config.decode_interval_seconds * self._bytes_per_second)
        if self._undecoded_bytes >= max(decode_interval_bytes, 1) and self._backend_ready():
            self._decode_window()

    def _decode_window(self) -> None:
        self._undecoded_bytes = 0
        if self._buffered_seconds() < self._config.min_decode_seconds:
            return
        tokens = self._safe_transcribe(bytes(self._buf))
        if tokens is None:
            return
        self._decoded_once = True
        result = self._policy.update(tokens)
        self._track_committed(result.committed)
        # Mid-utterance: show the running hypothesis as a partial under THIS
        # utterance's stable seg id (committed prefix + interim tail).
        self._emit_partial(result.partial)

    def _endpoint(self, *, force_flush: bool) -> None:
        """Close the current utterance: run a final decode if there is fresh
        un-decoded audio, flush the policy, emit ONE trailing ``final`` under the
        utterance's seg id, then reset for the next utterance."""
        if (
            self._buf
            and self._buffered_seconds() >= self._config.min_decode_seconds
            and self._backend_ready()
        ):
            tokens = self._safe_transcribe(bytes(self._buf))
            if tokens is not None:
                self._decoded_once = True
                self._track_committed(self._policy.update(tokens).committed)
        if force_flush and self._decoded_once:
            self._track_committed(self._policy.flush().committed)
            self._emit_final()
        self._reset_utterance()

    def _track_committed(self, committed: list[AsrToken]) -> None:
        """Append newly-committed tokens to the utterance's stable prefix."""
        if committed:
            self._committed_tokens.extend(committed)

    def _emit_partial(self, interim: list[AsrToken]) -> None:
        """Emit a ``partial`` = committed prefix + interim tail (updates in place)."""
        tokens = self._committed_tokens + list(interim)
        if not tokens:
            return
        self._emit(self._make_segment(tokens, status="partial"))
        self._emitted_current = True

    def _emit_final(self) -> None:
        """Emit ONE ``final`` for the utterance (its committed text), same seg id."""
        tokens = self._committed_tokens
        if not tokens:
            return
        self._emit(self._make_segment(tokens, status="final"))
        self._emitted_current = True

    def _make_segment(self, tokens: list[AsrToken], *, status: str) -> TranscriptSegment:
        text = " ".join(t.text for t in tokens).strip()
        base = self._buf_start_seconds or 0.0
        t_start = base + tokens[0].t_start
        t_end = base + tokens[-1].t_end
        return TranscriptSegment(
            meeting_id=self.meeting_id,
            source=self.source,
            text=text,
            t_start=t_start,
            t_end=t_end,
            status=status,
            seg_id=_seg_id(self.meeting_id, self.source, self._utterance_index),
        )

    def _reset_utterance(self) -> None:
        self._buf.clear()
        self._buf_start_seconds = None
        self._undecoded_bytes = 0
        self._decoded_once = False
        self._speech_seen = False
        self._committed_tokens = []
        self._policy.reset()
        self._vad.reset()
        # Advance ONLY if this utterance actually emitted something, so a stretch
        # of pure silence (no decode) does not burn seg ids. Each utterance that
        # emits gets a fresh, monotonic, non-overlapping seg id.
        if self._emitted_current:
            self._utterance_index += 1
        self._emitted_current = False

    def _safe_transcribe(self, pcm: bytes) -> Optional[list[AsrToken]]:
        try:
            return list(
                self._backend.transcribe(
                    pcm, sample_rate=self._config.sample_rate, language=self._language
                )
            )
        except Exception:  # noqa: BLE001 - a decode error degrades to a dropped window.
            logger.exception("ASR transcribe failed for %s/%s", self.meeting_id, self.source)
            return None

    def _buffered_seconds(self) -> float:
        return len(self._buf) / self._bytes_per_second

    def _frame_offset_seconds(self, frame: DecodedFrame) -> float:
        origin = self._meeting_origin_ms or 0.0
        return max(0.0, (frame.timestamp_ms - origin) / 1000.0)


def make_pipeline_factory(config: Optional[PipelineConfig] = None):
    """Return a :data:`PipelineFactory` building real streaming pipelines.

    Wire it into a :class:`~loqui_sidecar.transcription.manager.TranscriptionManager`
    (``pipeline_factory=make_pipeline_factory(...)``) to replace the inert
    Foundation ``_NoopPipeline``. The factory adapts the manager's call shape
    ``(meeting_id, source, emit, backend, transcription_config)`` — it reads
    ``transcription_config.language`` so the manager's :class:`TranscriptionConfig`
    still governs language while the streaming knobs come from ``config``.
    """
    cfg = config or PipelineConfig()

    def factory(meeting_id, source, emit, backend, transcription_config):
        lang = getattr(transcription_config, "language", None)
        return StreamingTranscriptionPipeline(
            meeting_id,
            source,
            emit,
            backend,
            config=cfg,
            language=lang,
        )

    return factory
