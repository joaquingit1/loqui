"""Audio fixture helpers for the PRD-2 transcription tests.

Two kinds of helpers:

* **Synthetic** (hermetic, no deps): :func:`tone`, :func:`silence`,
  :func:`concat`, :func:`white_noise` build ``pcm_s16le`` buffers from pure
  stdlib math for the VAD unit tests (tone+silence segmentation) and as
  deterministic input to the fake ASR backend.
* **Real speech** (opt-in, macOS only): :func:`say_to_wav` / :func:`load_wav_pcm`
  synthesize speech with macOS ``say`` and transcode to 16 kHz mono ``pcm_s16le``
  for the real-model smoke. These skip cleanly when ``say`` / ``afconvert`` are
  unavailable (they raise :class:`FixtureUnavailable`, which the smoke turns into
  a pytest skip).
"""

from __future__ import annotations

import array
import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path
from typing import List

SAMPLE_RATE = 16000
SAMPLE_WIDTH_BYTES = 2  # pcm_s16le
_INT16_MAX = 32767


class FixtureUnavailable(RuntimeError):
    """Raised when a real-speech fixture can't be produced (no say/afconvert)."""


# -- synthetic pcm_s16le builders --------------------------------------------


def _ms_to_samples(ms: float, sample_rate: int = SAMPLE_RATE) -> int:
    return int(round(sample_rate * ms / 1000.0))


def silence(ms: float, sample_rate: int = SAMPLE_RATE) -> bytes:
    """``ms`` of digital silence as ``pcm_s16le`` mono bytes."""
    return b"\x00\x00" * _ms_to_samples(ms, sample_rate)


def tone(
    ms: float,
    freq: float = 220.0,
    amplitude: float = 0.5,
    sample_rate: int = SAMPLE_RATE,
) -> bytes:
    """A pure sine tone of ``ms`` at ``freq`` Hz, ``amplitude`` 0..1 full-scale.

    A loud-ish tone reads as "speech-like" energy for the energy/ZCR VAD (its ZCR
    is low at low frequencies, mimicking voiced speech).
    """
    n = _ms_to_samples(ms, sample_rate)
    amp = int(max(0.0, min(1.0, amplitude)) * _INT16_MAX)
    buf = array.array("h")
    two_pi_f = 2.0 * math.pi * freq
    for i in range(n):
        buf.append(int(amp * math.sin(two_pi_f * i / sample_rate)))
    return buf.tobytes()


def white_noise(
    ms: float,
    amplitude: float = 0.05,
    sample_rate: int = SAMPLE_RATE,
    seed: int = 1234,
) -> bytes:
    """Low-amplitude pseudo-random noise (deterministic via ``seed``).

    Models ambient hiss: high zero-crossing rate, low energy — the VAD should
    NOT classify it as speech at the default threshold.
    """
    import random

    rng = random.Random(seed)
    n = _ms_to_samples(ms, sample_rate)
    amp = int(max(0.0, min(1.0, amplitude)) * _INT16_MAX)
    buf = array.array("h")
    for _ in range(n):
        buf.append(rng.randint(-amp, amp))
    return buf.tobytes()


def concat(*chunks: bytes) -> bytes:
    """Join ``pcm_s16le`` chunks in order."""
    return b"".join(chunks)


def pcm_duration_seconds(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> float:
    """Duration in seconds of a ``pcm_s16le`` mono buffer."""
    return (len(pcm) // SAMPLE_WIDTH_BYTES) / float(sample_rate)


# -- real-speech helpers (opt-in, macOS) -------------------------------------


def say_to_wav(text: str, path: str | Path) -> Path:
    """Synthesize ``text`` with macOS ``say`` to a 16 kHz mono pcm_s16le WAV.

    Raises :class:`FixtureUnavailable` when ``say`` or ``afconvert`` is missing,
    so the opt-in real-model smoke can convert it into a clean pytest skip.
    """
    say = shutil.which("say")
    if say is None:
        raise FixtureUnavailable("macOS `say` (TTS) not available")
    afconvert = shutil.which("afconvert")
    if afconvert is None:
        raise FixtureUnavailable("`afconvert` not available to transcode `say` output")
    out = Path(path)
    aiff = str(out) + ".aiff"
    subprocess.run([say, "-o", aiff, text], check=True)
    subprocess.run(
        [afconvert, "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, str(out)],
        check=True,
    )
    return out


def load_wav_pcm(path: str | Path) -> bytes:
    """Read a 16 kHz mono pcm_s16le WAV's frames as raw bytes (asserts format)."""
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE, w.getframerate()
        assert w.getnchannels() == 1, w.getnchannels()
        assert w.getsampwidth() == SAMPLE_WIDTH_BYTES, w.getsampwidth()
        return w.readframes(w.getnframes())


def rms_of_pcm(pcm: bytes) -> float:
    """Normalized RMS (0..1 full-scale) of a ``pcm_s16le`` buffer (debug aid)."""
    usable = len(pcm) - (len(pcm) % SAMPLE_WIDTH_BYTES)
    if usable == 0:
        return 0.0
    samples = struct.unpack(f"<{usable // 2}h", pcm[:usable])
    energy = sum(float(s) * float(s) for s in samples)
    return (energy / len(samples)) ** 0.5 / 32768.0


def segment_bounds_samples(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> List[int]:
    """Sample-index helper for tests asserting where chunks were placed."""
    return [0, len(pcm) // SAMPLE_WIDTH_BYTES]
