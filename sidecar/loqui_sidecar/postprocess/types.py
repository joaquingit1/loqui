"""Post-processing contract types (PRD-5) — the precise seams the diarization +
alignment + summary build units implement against.

Nothing here does heavy work — these are the *shapes*, *protocols*, and the
PURE alignment helpers. Keeping them in one module (NO torch / pyannote import)
means the FakeDiarizer, the alignment unit tests, and the summary path can
import the contract without pulling the heavy/optional diarization dependency.

Mirrors the TS contract in ``packages/shared/src/postprocess.ts`` (camelCase on
the wire; snake_case here, mapped by the ``to_wire`` serializers).

CROSS-CUTTING INVARIANT (carried over from PRD-4): the AI never edits the
transcript. Diarization + alignment produce a SEPARATE derived file
(``transcript.diarized.{json,md}``) from the READ-ONLY structured transcript
(``transcript.jsonl``); the summary is a SEPARATE AI-derived file
(``summary.json``) produced via the PRD-4 provider read-only over the
transcript. ``transcript.live.md`` / ``transcript.jsonl`` / ``meta.json`` are
NEVER written here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol, runtime_checkable

# --- WS-notification event names (mirror of @loqui/shared POSTPROCESS_EVENT) ---

#: main -> sidecar: begin the diarization + alignment + summary pipeline.
POSTPROCESS_REQUEST_EVENT = "postProcess"
#: sidecar -> main: pipeline finished (carries data to index + finalize).
POSTPROCESS_DONE_EVENT = "postProcessDone"
#: sidecar -> main: long-running job progress (mirror of @loqui/shared EVENT.jobUpdate).
JOB_UPDATE_EVENT = "jobUpdate"
#: sidecar -> main: one streamed summary text delta while the summary job runs
#: (mirror of @loqui/shared EVENT.summaryToken / SUMMARY_TOKEN_EVENT).
SUMMARY_TOKEN_EVENT = "summaryToken"

#: JobUpdate ``kind`` values produced by this pipeline (mirror of @loqui/shared jobKind).
JOB_KIND_TRANSCRIPTION = "transcription"
JOB_KIND_DIARIZATION = "diarization"
JOB_KIND_SUMMARY = "summary"

#: Speaker labels (mirror of @loqui/shared SPEAKER_YOU_LABEL / SPEAKER_LABEL_PREFIX).
SPEAKER_YOU_LABEL = "You"
SPEAKER_LABEL_PREFIX = "Speaker"


# --- Diarization output -------------------------------------------------------


@dataclass(frozen=True)
class SpeakerTurn:
    """One diarized speaker turn over ``system.wav`` — ``[start, end)`` seconds
    from meeting start, attributed to a raw diarizer cluster id ``speaker``
    (e.g. ``"spk_0"``). NOT yet aligned to the transcript.

    Mirror of the TS ``SpeakerTurn``.
    """

    start: float
    end: float
    speaker: str

    def to_wire(self) -> dict:
        return {"start": self.start, "end": self.end, "speaker": self.speaker}


@dataclass
class DiarizationResult:
    """What a :class:`DiarizationBackend` produced.

    ``turns`` are the speaker turns over ``system.wav`` (empty when diarization
    was skipped). ``diarized`` is False when the backend degraded gracefully
    (e.g. the no-token sherpa-onnx models aren't downloaded yet, or — for the
    opt-in pyannote backend — torch/the HF token is unavailable) — the pipeline
    then labels every system segment a single fallback ``Speaker 1`` so the
    meeting still completes. With NO HF token the DEFAULT is the no-token
    sherpa-onnx backend (it does NOT mean "skipped"). ``backend`` identifies the
    model used (e.g. ``"sherpa-onnx/pyannote-segmentation+campplus"``,
    ``"pyannote/speaker-diarization-3.1"``, or ``"fake"``); ``note`` is a
    secret-free, user-facing reason when skipped.
    """

    turns: list[SpeakerTurn] = field(default_factory=list)
    diarized: bool = False
    backend: str = ""
    note: str = ""


# --- Structured transcript record (read from transcript.jsonl) ----------------


@dataclass(frozen=True)
class TranscriptRecord:
    """One structured transcript segment read from ``transcript.jsonl``
    (mirror of the TS ``StructuredTranscriptRecord``). The alignment input.

    ``source`` is ``"mic"`` ("You") or ``"system"`` ("They"); ``t_start``/
    ``t_end`` are seconds from meeting start. Read-only: alignment never writes
    this file.
    """

    seg_id: str
    source: str
    t_start: float
    t_end: float
    text: str

    @classmethod
    def from_wire(cls, obj: dict) -> "TranscriptRecord":
        return cls(
            seg_id=str(obj.get("segId", "")),
            source=str(obj.get("source", "")),
            t_start=float(obj.get("tStart", 0.0)),
            t_end=float(obj.get("tEnd", 0.0)),
            text=str(obj.get("text", "")),
        )


# --- Diarized transcript (alignment output) -----------------------------------


@dataclass
class DiarizedSegment:
    """One re-labeled transcript segment (mirror of the TS ``DiarizedSegment``).

    ``speaker`` is the stable label (``"You"`` for mic; ``"Speaker N"`` for a
    system cluster). ``display_name`` carries a user rename (None until renamed).
    """

    seg_id: str
    source: str
    text: str
    t_start: float
    t_end: float
    speaker: str = SPEAKER_YOU_LABEL
    display_name: Optional[str] = None

    def to_wire(self) -> dict:
        return {
            "segId": self.seg_id,
            "source": self.source,
            "text": self.text,
            "tStart": self.t_start,
            "tEnd": self.t_end,
            "speaker": self.speaker,
            "displayName": self.display_name,
        }


@dataclass
class DiarizedTranscript:
    """The full diarized-transcript document (mirror of the TS
    ``DiarizedTranscript``) persisted to ``transcript.diarized.json`` and
    rendered to ``transcript.diarized.md``.
    """

    meeting_id: str
    version: int = 1
    diarized: bool = False
    backend: str = ""
    speakers: list[str] = field(default_factory=list)
    segments: list[DiarizedSegment] = field(default_factory=list)

    def to_wire(self) -> dict:
        return {
            "meetingId": self.meeting_id,
            "version": self.version,
            "diarized": self.diarized,
            "backend": self.backend,
            "speakers": list(self.speakers),
            "segments": [s.to_wire() for s in self.segments],
        }


# --- Summary (AI-generated, read-only over the transcript) --------------------


@dataclass
class ActionItem:
    """One inferred action item (mirror of the TS ``ActionItem``)."""

    text: str = ""
    owner: Optional[str] = None

    def to_wire(self) -> dict:
        return {"text": self.text, "owner": self.owner}


@dataclass
class Summary:
    """The structured AI summary (mirror of the TS ``Summary``) the
    summary-writer persists to ``summary.json``. Built from the read-only
    transcript via the PRD-4 provider layer — the provider never edits the
    transcript.
    """

    meeting_id: str
    version: int = 1
    #: AI-generated headline (becomes the meeting title when not user-renamed).
    title: str = ""
    #: The meeting notes as markdown (themed sections + bullets) — the centerpiece.
    overview: str = ""
    tldr: str = ""  # LEGACY (pre-markdown summaries + JSON templates)
    decisions: list[str] = field(default_factory=list)  # LEGACY
    action_items: list[ActionItem] = field(default_factory=list)  # LEGACY
    topics: list[str] = field(default_factory=list)  # LEGACY
    provider: str = ""
    model: str = ""
    generated_at: str = ""

    def to_wire(self) -> dict:
        return {
            "meetingId": self.meeting_id,
            "version": self.version,
            "title": self.title,
            "overview": self.overview,
            "tldr": self.tldr,
            "decisions": list(self.decisions),
            "actionItems": [a.to_wire() for a in self.action_items],
            "topics": list(self.topics),
            "provider": self.provider,
            "model": self.model,
            "generatedAt": self.generated_at,
        }


# --- DiarizationBackend protocol ----------------------------------------------


@runtime_checkable
class DiarizationBackend(Protocol):
    """Injectable speaker-diarization backend — the single seam that decouples
    the post-processing pipeline from pyannote/torch so the unit gate stays
    hermetic.

    The default gate injects :class:`~loqui_sidecar.postprocess.fake.FakeDiarizer`
    (deterministic scripted turns, NO deps). The real build unit provides
    :class:`~loqui_sidecar.postprocess.pyannote_backend.PyannoteDiarizer`
    (pyannote.audio 3.1, lazy-imports torch + pyannote); it is exercised only by
    the opt-in real-diarization test.

    Contract:

    * :attr:`name` — short identifier surfaced in ``DiarizationResult.backend``
      + ``/health`` models (e.g. ``"pyannote/speaker-diarization-3.1"`` /
      ``"fake"``).
    * :meth:`diarize` — run offline diarization on the mono WAV at ``wav_path``
      (always ``system.wav`` — the "They" stream; mic is known to be "You") and
      return a :class:`DiarizationResult`. ``hf_token`` is the transient Hugging
      Face token for the gated weights (None when unconfigured). The real backend
      MUST degrade gracefully — when torch/pyannote/the token/the file is
      unavailable it returns ``DiarizationResult(diarized=False, note=...)``
      rather than raising, so the meeting still completes. MUST NOT block on the
      event loop's expectation of returning quickly (it is run on the postprocess
      executor). Idempotent: re-running over the same WAV yields the same turns.
    """

    @property
    def name(self) -> str: ...

    def diarize(self, wav_path: str, hf_token: Optional[str] = None) -> DiarizationResult: ...


# --- Emit signature -----------------------------------------------------------

#: The low-level WS notification sender app.py owns: ``emit(event, data)``. Each
#: call becomes one ``{type:"notification", event, data}`` frame on the live WS.
#: Thread-safe (schedules onto the serving loop). Same type as the PRD-4
#: ``ChatEmit`` / the transcription ``NotificationSender``.
PostProcessEmit = Callable[[str, dict], None]
