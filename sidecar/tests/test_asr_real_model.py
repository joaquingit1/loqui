"""Opt-in, best-effort REAL-model ASR smoke (PRD-2).

This is NOT part of the default unit gate. It is skipped cleanly unless ALL of:

* ``LOQUI_RUN_ASR_TESTS`` is set in the environment, AND
* the real faster-whisper backend build unit exists
  (``loqui_sidecar.transcription.asr_backend.FasterWhisperBackend``), AND
* macOS ``say`` (TTS) is available to synthesize real speech, AND
* faster-whisper can load the tiny model (downloads on first use).

The default ``uv run pytest`` (no network) never runs the body — it skips here,
so the hermetic unit gate stays fast + offline. When the real backend lands and
``LOQUI_RUN_ASR_TESTS=1`` is set, this transcribes ``say``-generated speech and
asserts a recognizable word, proving the real backend honors the
:class:`~loqui_sidecar.transcription.AsrBackend` contract end-to-end.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import wave

import pytest

RUN = os.environ.get("LOQUI_RUN_ASR_TESTS")

pytestmark = pytest.mark.skipif(
    not RUN,
    reason="real-model ASR smoke is opt-in; set LOQUI_RUN_ASR_TESTS=1 to run",
)


def _say_to_wav(text: str, path: str) -> None:
    """Synthesize speech with macOS `say` to a 16 kHz mono pcm_s16le WAV."""
    say = shutil.which("say")
    if say is None:
        pytest.skip("macOS `say` (TTS) not available")
    aiff = path + ".aiff"
    subprocess.run([say, "-o", aiff, text], check=True)
    afconvert = shutil.which("afconvert")
    if afconvert is None:
        pytest.skip("`afconvert` not available to transcode `say` output")
    subprocess.run(
        [afconvert, "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, path],
        check=True,
    )


def _load_pcm(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1
        return w.readframes(w.getnframes())


def test_real_faster_whisper_transcribes_say_speech(tmp_path):
    try:
        from loqui_sidecar.transcription.asr_backend import FasterWhisperBackend
    except Exception:  # noqa: BLE001 - build unit not present yet.
        pytest.skip("real FasterWhisperBackend not implemented yet (build unit)")

    wav = str(tmp_path / "speech.wav")
    _say_to_wav("the quick brown fox", wav)
    pcm = _load_pcm(wav)

    backend = FasterWhisperBackend(model_size="tiny", device="cpu", compute_type="int8")
    try:
        backend.load()
    except Exception as exc:  # noqa: BLE001 - no network / model unavailable.
        pytest.skip(f"tiny model unavailable: {exc}")

    tokens = backend.transcribe(pcm, sample_rate=16000, language="en")
    text = " ".join(t.text for t in tokens).lower()
    assert any(word in text for word in ("quick", "brown", "fox")), text
