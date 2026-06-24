"""FakeDiarizer — a deterministic, scripted DiarizationBackend (PRD-5).

Hermetic: NO torch, NO pyannote, NO model, NO audio decode, NO network. The
DEFAULT unit gate + the post-processing smoke select this so the diarization +
alignment + summary pipeline is exercised end-to-end without any heavy/optional
dependency.

It produces a fixed set of speaker turns (two remote speakers alternating) over
a notional meeting timeline so the alignment step has ≥2 system speakers to
assign — letting a test assert correct speaker attribution against known turns.
"""

from __future__ import annotations

import os
from typing import Optional

from .types import DiarizationResult, SpeakerTurn

#: Env flag that forces the FAKE diarizer regardless of injection (set for the
#: unit gate + post-processing smoke). Mirrors ``LOQUI_FAKE_CHAT`` / ``LOQUI_FAKE_ASR``.
FAKE_DIARIZER_ENV = "LOQUI_FAKE_DIARIZER"


def fake_diarizer_enabled() -> bool:
    val = os.environ.get(FAKE_DIARIZER_ENV)
    return bool(val) and val not in ("0", "false", "False", "")


#: Default scripted turn length (seconds) for the synthesized two-speaker script.
_TURN_SECONDS = 3.0
#: The two remote-speaker cluster ids the synthesized script alternates between.
_FAKE_SPEAKERS = ("spk_0", "spk_1")


def scripted_turns(duration: float) -> list[SpeakerTurn]:
    """Deterministically synthesize an alternating two-speaker turn script that
    spans ``[0, duration)`` in :data:`_TURN_SECONDS` chunks (≥2 system speakers).

    PURE + deterministic (same ``duration`` -> identical turns), so the fake
    diarizer can derive its turns from the WAV length while staying hermetic. A
    non-positive/garbage ``duration`` collapses to the fixed 12s script so
    alignment always has ≥2 speakers to assign.
    """
    if not (duration and duration > 0):
        duration = 4 * _TURN_SECONDS  # 12s -> 4 turns -> 2 speakers, twice each.
    turns: list[SpeakerTurn] = []
    start = 0.0
    i = 0
    while start < duration:
        end = min(start + _TURN_SECONDS, duration)
        turns.append(SpeakerTurn(start=start, end=end, speaker=_FAKE_SPEAKERS[i % 2]))
        start = end
        i += 1
    # Guarantee ≥2 distinct speakers even for a very short window.
    if len({t.speaker for t in turns}) < 2 and turns:
        turns.append(
            SpeakerTurn(
                start=turns[-1].end, end=turns[-1].end + _TURN_SECONDS, speaker=_FAKE_SPEAKERS[1]
            )
        )
    return turns


def _wav_duration_seconds(wav_path: str) -> Optional[float]:
    """Best-effort WAV duration via the stdlib ``wave`` module (NO deps).

    Returns None when the path is missing/unreadable/not a WAV, so the diarizer
    falls back to the fixed script — keeping the hermetic gate (which passes a
    nonexistent path) deterministic.
    """
    if not wav_path or not os.path.exists(wav_path):
        return None
    try:
        import wave

        with wave.open(wav_path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            if rate <= 0:
                return None
            return frames / float(rate)
    except Exception:  # noqa: BLE001 - any decode issue => fall back to the script.
        return None


class FakeDiarizer:
    """Deterministic scripted diarizer. Synthesizes an alternating two-speaker
    turn script (≥2 remote speakers) so alignment + the rest of the pipeline run
    with no audio model. Never raises; never reads the network.

    Turn selection (in priority order):

    * an explicit ``turns`` list passed to the constructor (a test fixture); else
    * a script scaled to the WAV's duration when ``wav_path`` points at a readable
      WAV (read via the stdlib ``wave`` module — NO heavy deps); else
    * the fixed 12s / four-turn / two-speaker script (the hermetic gate path,
      where the WAV is absent — keeps the fake-backed pipeline output stable).
    """

    name = "fake"

    def __init__(self, turns: Optional[list[SpeakerTurn]] = None) -> None:
        self._turns = turns

    def diarize(self, wav_path: str, hf_token: Optional[str] = None) -> DiarizationResult:
        if self._turns is not None:
            turns = list(self._turns)
        else:
            duration = _wav_duration_seconds(wav_path)
            turns = scripted_turns(duration if duration is not None else 0.0)
        return DiarizationResult(turns=turns, diarized=True, backend=self.name, note="")


def default_diarizer() -> FakeDiarizer:
    """Construct the hermetic fake diarizer (the default gate backend)."""
    return FakeDiarizer()
