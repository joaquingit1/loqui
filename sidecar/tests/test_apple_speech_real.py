"""Opt-in, best-effort REAL Apple Speech smoke (PRD-9, macOS-only).

NOT part of the default unit gate. Skipped cleanly unless ALL of:

* ``LOQUI_RUN_APPLE_SPEECH_TESTS`` is set in the environment, AND
* the host is macOS (``sys.platform == "darwin"``), AND
* the compiled Swift helper binary is resolvable (``LOQUI_ASR_HELPER_BIN`` or
  ``loqui-asr-helper`` on PATH), AND
* macOS ``say`` (TTS) is available to synthesize real speech.

On Windows (this dev box) and in the default ``uv run pytest`` (no Swift, no
network) this test SKIPS — it never compiles Swift and never runs Apple Speech in
the hermetic gate. When run on a Mac with the helper built + the env flag set, it
drives the REAL helper (Apple Speech, on-device) on ``say``-generated audio and
asserts a recognizable word, proving the native backend honors the
:class:`~loqui_sidecar.transcription.AsrBackend` contract end-to-end.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import wave

import pytest

RUN = os.environ.get("LOQUI_RUN_APPLE_SPEECH_TESTS")

pytestmark = pytest.mark.skipif(
    not RUN or sys.platform != "darwin",
    reason="real Apple Speech smoke is opt-in + macOS-only; set "
    "LOQUI_RUN_APPLE_SPEECH_TESTS=1 on macOS to run",
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


def _read_pcm(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        return w.readframes(w.getnframes())


def test_apple_speech_transcribes_say_audio_on_device(tmp_path):
    from loqui_sidecar.transcription import NativeHelperBackend, resolve_helper_binary

    if resolve_helper_binary() is None:
        pytest.skip(
            "Swift ASR helper not built/resolvable; build apps/desktop/native/macos "
            "and set LOQUI_ASR_HELPER_BIN"
        )

    wav = str(tmp_path / "hello.wav")
    _say_to_wav("hello world this is a test", wav)
    pcm = _read_pcm(wav)

    # Default subprocess factory -> the real helper. apple-speech => zero model
    # download, requiresOnDeviceRecognition = true.
    backend = NativeHelperBackend("apple-speech")
    backend.load()
    try:
        tokens = backend.transcribe(pcm)
    finally:
        backend.close()

    text = " ".join(t.text for t in tokens).lower()
    assert any(word in text for word in ("hello", "world", "test")), text
