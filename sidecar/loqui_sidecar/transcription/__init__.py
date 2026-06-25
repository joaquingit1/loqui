"""Real-time transcription engine (PRD-2) — Foundation contract package.

This package defines the SEAMS the four PRD-2 build units implement against; it
ships the wiring + the interfaces, NOT the streaming/VAD/ASR logic. The build
units fill in:

* ``asr_backend`` — the real :class:`AsrBackend` over faster-whisper / CTranslate2.
* ``streaming_policy`` — the LocalAgreement-2 :class:`StreamingPolicy`.
* ``pipeline`` — VAD endpointing + the per-source :class:`TranscriptionPipeline`.
* the renderer transcript view (apps/desktop) — consumes the emitted segments.

Architecture (two INDEPENDENT pipelines, one per ``(meeting_id, source)``)::

    audio_ingest decoded PCM frames
        -> AudioIngest.add_consumer(TranscriptionManager)   # FrameConsumer hook
        -> TranscriptionManager routes each frame to the per-(meeting,source)
           TranscriptionPipeline
        -> pipeline: buffer PCM -> VAD endpoint -> AsrBackend.transcribe(window)
           -> StreamingPolicy (LocalAgreement-2) -> partial / final segments
        -> SegmentEmitter callback (one TranscriptSegment)
        -> sender emits a {type:"notification", event:"transcriptSegment", data}
           WS frame -> main forwards on IPC -> renderer "You"/"They" view.

mic ("You") and system ("They") never share a pipeline, a buffer, or a policy
state; the only thing tying a segment to its source is ``TranscriptSegment.source``.

TESTABILITY (the gate is hermetic + fast):

* :class:`AsrBackend` is an injectable Protocol. The default unit gate uses
  :class:`FakeAsrBackend` (scripted tokens) — NO model download, NO real
  inference, deterministic. ``faster-whisper`` is imported ONLY by the real
  backend build unit, behind a lazy import, and exercised by a SEPARATE
  best-effort "real-model smoke" that is skipped unless ``LOQUI_RUN_ASR_TESTS``
  is set AND the model/``say`` are available (see tests/).

Wire contract (do NOT drift from ``@loqui/shared`` ``TranscriptSegment`` /
``packages/shared/src/events.ts``)::

    TranscriptSegment {
      meetingId: str (uuid)            # the meeting this segment belongs to
      source:    "mic" | "system"      # independent per-source pipeline
      text:      str                   # segment text (may be "")
      tStart:    float (seconds)       # from meeting start
      tEnd:      float (seconds)       # from meeting start
      status:    "partial" | "final"   # partial superseded by final w/ same segId
      segId:     str (non-empty)       # stable id; final reuses its partials' id
    }
    event name = "transcriptSegment"  (TRANSCRIPT_SEGMENT_EVENT)
"""

from __future__ import annotations

from .types import (
    TRANSCRIPT_SEGMENT_EVENT,
    AsrBackend,
    AsrToken,
    PolicyResult,
    SegmentEmitter,
    StreamingPolicy,
    TranscriptSegment,
)
from .fake_backend import FakeAsrBackend
from .streaming import LocalAgreementPolicy
from .manager import (
    TranscriptionConfig,
    TranscriptionManager,
    default_transcription_manager,
    make_ws_emitter,
)
from .native_backend import (
    HelperProcess,
    NativeHelperBackend,
    probe_capabilities,
    resolve_helper_binary,
)
from .engine_select import (
    BackendSelection,
    EngineSelection,
    resolve_engine_selection,
    select_backend,
)

__all__ = [
    "TRANSCRIPT_SEGMENT_EVENT",
    "AsrBackend",
    "AsrToken",
    "PolicyResult",
    "SegmentEmitter",
    "StreamingPolicy",
    "TranscriptSegment",
    "FakeAsrBackend",
    "LocalAgreementPolicy",
    "TranscriptionConfig",
    "TranscriptionManager",
    "default_transcription_manager",
    "make_ws_emitter",
    # PRD-9 pluggable engines.
    "HelperProcess",
    "NativeHelperBackend",
    "probe_capabilities",
    "resolve_helper_binary",
    "BackendSelection",
    "EngineSelection",
    "resolve_engine_selection",
    "select_backend",
]
