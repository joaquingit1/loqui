"""Post-meeting diarization + AI summaries (PRD-5) — Foundation contract package.

This package defines the SEAMS the PRD-5 build units implement against; it ships
the wiring + interfaces + the hermetic FAKE diarizer + the PURE alignment + the
read-only summary path, NOT the real pyannote diarization or the structured
summary parsing. The build units fill in:

* ``pyannote_backend.PyannoteDiarizer.diarize`` — the real pyannote.audio 3.1
  body (behind the fixed signature + the graceful-degradation guards).
* ``summary.summarize`` — structured parsing of the provider output into the
  Summary fields (Foundation puts the raw text in ``tldr``).
* ``align.align`` — may refine the overlap heuristic (signature is fixed).
* main (apps/desktop) — the postProcess request trigger + indexing + the UI.

CROSS-CUTTING INVARIANT: the AI never edits the transcript. Diarization +
alignment write a SEPARATE derived file (transcript.diarized.{json,md}) from the
READ-ONLY structured transcript; the summary is a SEPARATE AI-derived file
(summary.json) via the PRD-4 provider read-only over the transcript. The live
transcript stays byte-identical.

Pins: pyannote.audio 3.1 (NOT Sortformer); torch + pyannote are an OPTIONAL uv
dependency-group (NOT installed by default); FakeDiarizer drives the gate; the
summary reuses the PRD-4 provider layer read-only.
"""

from __future__ import annotations

from .types import (
    JOB_KIND_DIARIZATION,
    JOB_KIND_SUMMARY,
    JOB_UPDATE_EVENT,
    POSTPROCESS_DONE_EVENT,
    POSTPROCESS_REQUEST_EVENT,
    SPEAKER_LABEL_PREFIX,
    SPEAKER_YOU_LABEL,
    ActionItem,
    DiarizationBackend,
    DiarizationResult,
    DiarizedSegment,
    DiarizedTranscript,
    PostProcessEmit,
    SpeakerTurn,
    Summary,
    TranscriptRecord,
)
from .request import PostProcessRequest
from .align import align, distinct_system_speakers
from .fake import (
    FAKE_DIARIZER_ENV,
    FakeDiarizer,
    default_diarizer,
    fake_diarizer_enabled,
    scripted_turns,
)
from .pyannote_backend import (
    PYANNOTE_PIPELINE,
    DiarizationUnavailable,
    PyannoteDiarizer,
    pyannote_factory,
)
from .summary import SUMMARY_INSTRUCTION, summarize
from .writers import (
    diarized_json_path,
    diarized_md_path,
    render_diarized_md,
    summary_path,
    write_diarized_transcript,
    write_summary,
)
from .runner import (
    DiarizerFactory,
    default_diarizer_factory,
    run_postprocess,
)

__all__ = [
    # event names + kinds + labels
    "POSTPROCESS_REQUEST_EVENT",
    "POSTPROCESS_DONE_EVENT",
    "JOB_UPDATE_EVENT",
    "JOB_KIND_DIARIZATION",
    "JOB_KIND_SUMMARY",
    "SPEAKER_YOU_LABEL",
    "SPEAKER_LABEL_PREFIX",
    # contract types
    "SpeakerTurn",
    "DiarizationResult",
    "DiarizationBackend",
    "TranscriptRecord",
    "DiarizedSegment",
    "DiarizedTranscript",
    "ActionItem",
    "Summary",
    "PostProcessEmit",
    "PostProcessRequest",
    # pure alignment
    "align",
    "distinct_system_speakers",
    # fake diarizer (the gate backend)
    "FakeDiarizer",
    "default_diarizer",
    "fake_diarizer_enabled",
    "FAKE_DIARIZER_ENV",
    "scripted_turns",
    # real diarizer build-unit seam
    "PyannoteDiarizer",
    "pyannote_factory",
    "PYANNOTE_PIPELINE",
    "DiarizationUnavailable",
    # summary seam
    "summarize",
    "SUMMARY_INSTRUCTION",
    # derived-file writers
    "write_diarized_transcript",
    "write_summary",
    "render_diarized_md",
    "diarized_json_path",
    "diarized_md_path",
    "summary_path",
    # runner
    "run_postprocess",
    "default_diarizer_factory",
    "DiarizerFactory",
]
