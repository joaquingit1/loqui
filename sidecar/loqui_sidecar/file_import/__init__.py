"""File-import transcription (PRD-12).

"Transcribe a file": decode an existing audio/video file to the SAME 16 kHz
mono pcm_s16le PCM the live capture path produces, run it through the EXISTING
transcription engine (:mod:`loqui_sidecar.transcription`), write the SAME
transcript files a live meeting writes (``transcript.live.md`` +
``transcript.jsonl``) plus a ``system.wav`` so the EXISTING diarization can read
it, then run the EXISTING diarization + summary
(:func:`loqui_sidecar.postprocess.run_postprocess`).

It is a SINGLE-stream source (no separate You/They): the decoded audio is fed as
the ``system`` stream so the existing alignment labels every speaker
``Speaker 1/2/…`` (never "You"). No pipeline logic is duplicated — this package
only adds the file-decode front end + the offline driver around the reused
streaming pipeline + post-process.
"""

from __future__ import annotations

from .decode import DecodeError, decode_to_pcm16k_mono, iter_decoded_frames
from .importer import run_import

__all__ = [
    "DecodeError",
    "decode_to_pcm16k_mono",
    "iter_decoded_frames",
    "run_import",
]
