"""Opt-in REAL pyannote.audio 3.1 diarization test (PRD-5 — HONEST DEFERRAL).

This is the only test that touches the real, heavy, gated diarization path. It is
SKIPPED by default and runs ONLY when the user opts in, because it needs:

* ``LOQUI_RUN_DIARIZATION=1`` (the explicit opt-in flag), AND
* ``HF_TOKEN`` (a Hugging Face token with the gated ``pyannote/speaker-diarization-3.1``
  model terms accepted), AND
* the optional ``diarization`` dependency group installed (``uv sync --group
  diarization`` -> torch + pyannote.audio), AND
* ``LOQUI_DIARIZATION_WAV`` pointing at a real multi-speaker mono WAV.

The automated hermetic gate (``test_diarization.py`` + ``test_alignment.py``)
covers FakeDiarizer + the real PURE alignment + the diarized writer + graceful
degradation; the REAL model run is verified here (manually / in an opt-in CI lane)
so the default ``uv run pytest`` stays offline, key-free, and torch-free.

Run it with::

    uv sync --group diarization
    LOQUI_RUN_DIARIZATION=1 HF_TOKEN=hf_xxx \
      LOQUI_DIARIZATION_WAV=/path/to/multi_speaker.wav \
      uv run pytest -q tests/test_diarization_real.py
"""

from __future__ import annotations

import os

import pytest

# Skip the whole module unless the user explicitly opted in AND has a token.
pytestmark = pytest.mark.skipif(
    not os.getenv("LOQUI_RUN_DIARIZATION") or not os.getenv("HF_TOKEN"),
    reason=(
        "real diarization opt-in: set LOQUI_RUN_DIARIZATION=1 + HF_TOKEN (and "
        "install the 'diarization' uv group) to run pyannote.audio for real"
    ),
)

# Import-skip if torch / pyannote.audio are not installed (the optional group).
torch = pytest.importorskip("torch", reason="install the 'diarization' uv group")
pytest.importorskip(
    "pyannote.audio", reason="install the 'diarization' uv group (pyannote.audio 3.1)"
)

from loqui_sidecar.postprocess import (  # noqa: E402 - after the import guards.
    PYANNOTE_PIPELINE,
    PyannoteDiarizer,
    SpeakerTurn,
    align,
    distinct_system_speakers,
)
from loqui_sidecar.postprocess.types import TranscriptRecord  # noqa: E402


def _real_wav() -> str:
    wav = os.getenv("LOQUI_DIARIZATION_WAV")
    if not wav or not os.path.exists(wav):
        pytest.skip(
            "set LOQUI_DIARIZATION_WAV to a real multi-speaker mono WAV to run "
            "the real diarization test"
        )
    return wav


def test_real_pyannote_produces_speaker_turns():
    """The real pipeline returns ordered, well-formed speaker turns and the
    backend is pinned to 3.1."""
    wav = _real_wav()
    diarizer = PyannoteDiarizer()
    assert diarizer.name == PYANNOTE_PIPELINE

    result = diarizer.diarize(wav, hf_token=os.environ["HF_TOKEN"])

    # If the token/terms are wrong the backend degrades (diarized=False) with a
    # secret-free, actionable note — make that an explicit, debuggable failure.
    assert result.diarized, f"diarization degraded: {result.note!r}"
    assert os.environ["HF_TOKEN"] not in (result.note or "")
    assert result.turns, "expected at least one speaker turn"
    for t in result.turns:
        assert isinstance(t, SpeakerTurn)
        assert t.end > t.start >= 0.0
        assert t.speaker
    # Turns are time-ordered (deterministic ordering for idempotency).
    starts = [t.start for t in result.turns]
    assert starts == sorted(starts)


def test_real_pyannote_distinguishes_multiple_speakers_and_aligns():
    """End-to-end over a real WAV: ≥2 remote speakers, and alignment over a
    synthetic transcript that mirrors the turns labels them Speaker 1/2/..."""
    wav = _real_wav()
    result = PyannoteDiarizer().diarize(wav, hf_token=os.environ["HF_TOKEN"])
    assert result.diarized, f"diarization degraded: {result.note!r}"

    distinct = {t.speaker for t in result.turns}
    assert len(distinct) >= 2, f"expected >=2 remote speakers in the fixture WAV, got {distinct}"

    # Build one system-source transcript record per turn (centered in the turn)
    # plus a mic segment, and align: mic -> You; each system seg -> a Speaker N.
    segs = [TranscriptRecord(seg_id="mic1", source="mic", t_start=0.0, t_end=0.5, text="hi")]
    for i, t in enumerate(result.turns):
        mid = (t.start + t.end) / 2.0
        segs.append(
            TranscriptRecord(
                seg_id=f"sys{i}",
                source="system",
                t_start=mid - 0.01,
                t_end=mid + 0.01,
                text=f"turn {i}",
            )
        )
    aligned = align(segs, result.turns)
    assert aligned[0].speaker == "You"
    speakers = distinct_system_speakers(aligned)
    assert len(speakers) >= 2
    assert all(s.startswith("Speaker ") for s in speakers)


def test_real_pyannote_is_idempotent():
    """Re-running diarization over the same WAV yields the same turns (PRD-5 AC#2)."""
    wav = _real_wav()
    diarizer = PyannoteDiarizer()
    a = diarizer.diarize(wav, hf_token=os.environ["HF_TOKEN"])
    b = diarizer.diarize(wav, hf_token=os.environ["HF_TOKEN"])
    assert a.diarized and b.diarized
    key_a = [(round(t.start, 3), round(t.end, 3), t.speaker) for t in a.turns]
    key_b = [(round(t.start, 3), round(t.end, 3), t.speaker) for t in b.turns]
    assert key_a == key_b
