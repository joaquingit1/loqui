"""Opt-in REAL sherpa-onnx diarization test (PRD-14 — no token, no account).

This is the only sherpa test that runs the real ONNX models. It is SKIPPED by
default and runs ONLY when the user opts in, because it needs the (Apache-2.0,
non-gated) ONNX models cached locally. Unlike the pyannote real test it needs NO
Hugging Face token and NO account — that is the entire point of PRD-14.

It runs ONLY when ``LOQUI_RUN_REAL_DIARIZATION=1`` (the explicit opt-in flag).
When opted in it is SELF-CONTAINED — it will, with NO Hugging Face token and NO
account (the entire point of PRD-14):

* DOWNLOAD the two Apache-2.0 ONNX models from sherpa-onnx's non-gated GitHub
  releases (once; cached under ``LOQUI_SHERPA_MODELS_DIR`` or the data dir), and
* obtain a 2-speaker mono 16 kHz WAV — either ``LOQUI_DIARIZATION_WAV`` if set,
  else it SYNTHESIZES one with two different Windows SAPI voices (Windows only;
  skips elsewhere if no WAV is provided),

then run the REAL ONNX diarizer (in its isolated child process) and assert
``diarized=True`` with >= 2 distinct speakers.

The hermetic gate (``test_diarization_sherpa.py``) covers the mapping + graceful
degradation + selection with the runtime + models stubbed; this verifies the
REAL ONNX run. It NEVER runs (and so never downloads) in the normal
``uv run pytest`` gate, which both leaves ``LOQUI_RUN_REAL_DIARIZATION`` unset
AND sets ``LOQUI_NO_MODEL_DOWNLOAD=1``.

Run it (a fresh install, no token, no manual model staging) with::

    LOQUI_RUN_REAL_DIARIZATION=1 uv run pytest -q tests/test_diarization_sherpa_real.py
"""

from __future__ import annotations

import os
import struct
import wave

import pytest

# Skip the whole module unless the user explicitly opted in.
pytestmark = pytest.mark.skipif(
    not os.getenv("LOQUI_RUN_REAL_DIARIZATION"),
    reason=(
        "real sherpa-onnx diarization opt-in: set LOQUI_RUN_REAL_DIARIZATION=1 "
        "(no HF token needed) to download the models + run the real ONNX models"
    ),
)

# Import-skip if the sherpa_onnx runtime is somehow unavailable.
pytest.importorskip("sherpa_onnx", reason="sherpa-onnx is a base dependency; reinstall it")

from loqui_sidecar.postprocess import (  # noqa: E402 - after the import guards.
    SHERPA_BACKEND_NAME,
    SherpaOnnxDiarizer,
    SpeakerTurn,
    align,
    distinct_system_speakers,
    sherpa_models,
)
from loqui_sidecar.postprocess.types import TranscriptRecord  # noqa: E402


def _require_models() -> None:
    """Resolve the ONNX models, FETCHING them once (non-gated, no token) if the
    cache is empty. Opting in (``LOQUI_RUN_REAL_DIARIZATION=1``) IS the user's
    consent to the one-time download, so this temporarily lifts the hermetic
    gate's ``LOQUI_NO_MODEL_DOWNLOAD`` guard (conftest sets it for every test)
    — but NOT when the models are pinned to an explicit
    ``LOQUI_SHERPA_MODELS_DIR`` (PRD-8 bundled-models dir), which must be staged."""
    if sherpa_models.resolve_models() is not None:
        return
    if os.getenv(sherpa_models.SHERPA_MODELS_DIR_ENV, "").strip():
        pytest.skip(
            "LOQUI_SHERPA_MODELS_DIR is set but empty; stage the ONNX models there "
            "(a pinned bundled-models dir is never auto-downloaded)."
        )
    # Lift only the conftest NO_MODEL_DOWNLOAD default for this opt-in fetch.
    prev = os.environ.pop(sherpa_models.NO_MODEL_DOWNLOAD_ENV, None)
    try:
        fetched = sherpa_models.fetch_models()
    finally:
        if prev is not None:
            os.environ[sherpa_models.NO_MODEL_DOWNLOAD_ENV] = prev
    if fetched is None or sherpa_models.resolve_models() is None:
        pytest.skip("could not download the non-gated sherpa-onnx ONNX models (offline?)")


def _synthesize_two_speaker_wav() -> str:
    """Synthesize a 2-speaker mono 16 kHz WAV via Windows SAPI (two distinct
    installed voices). Returns the path, or skips on non-Windows / no SAPI."""
    import platform

    if platform.system() != "Windows":
        pytest.skip("set LOQUI_DIARIZATION_WAV; SAPI synthesis is Windows-only")

    out_dir = sherpa_models.models_cache_dir().parent / "test-audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "synth_2spk_16k.wav"
    if out.is_file():
        return str(out)

    lines = [
        ("Microsoft David Desktop", "Hello, this is the first speaker talking about the project."),
        ("Microsoft Zira Desktop", "And this is a completely different second speaker responding."),
        ("Microsoft David Desktop", "The first speaker again, wrapping up the short conversation."),
        (
            "Microsoft Zira Desktop",
            "The second speaker says goodbye now. Thanks everyone for joining.",
        ),
    ]
    parts: list[bytes] = []
    rate = 16000
    try:
        import clr  # noqa: F401 - only present with pythonnet; fall back below.
    except Exception:  # noqa: BLE001
        clr = None

    if clr is None:
        # Drive SAPI through PowerShell (System.Speech) — no extra Python dep.
        import subprocess
        import sys as _sys

        for i, (voice, text) in enumerate(lines):
            seg = out_dir / f"_seg{i}.wav"
            ps = (
                "Add-Type -AssemblyName System.Speech;"
                "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
                f"try{{$s.SelectVoice('{voice}')}}catch{{}};"
                "$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo("
                "16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,"
                "[System.Speech.AudioFormat.AudioChannel]::Mono);"
                f"$s.SetOutputToWaveFile('{seg}',$fmt);"
                f"$s.Speak('{text}');$s.Dispose()"
            )
            r = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True,
                text=True,
            )
            if r.returncode != 0 or not seg.is_file():
                pytest.skip(f"SAPI synthesis failed: {r.stderr.strip()[:200]}")
            with wave.open(str(seg), "rb") as wf:
                assert wf.getframerate() == rate and wf.getnchannels() == 1
                parts.append(wf.readframes(wf.getnframes()))
            seg.unlink(missing_ok=True)
        _ = _sys  # quiet linters

    # Concatenate the per-voice PCM into one mono 16 kHz WAV.
    with wave.open(str(out), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        # A little silence between turns helps segmentation.
        gap = struct.pack("<%dh" % (rate // 4), *([0] * (rate // 4)))
        for p in parts:
            wf.writeframes(p)
            wf.writeframes(gap)
    return str(out)


def _real_wav() -> str:
    wav = os.getenv("LOQUI_DIARIZATION_WAV")
    if wav and os.path.exists(wav):
        return wav
    return _synthesize_two_speaker_wav()


def test_real_sherpa_produces_speaker_turns():
    _require_models()
    wav = _real_wav()
    diarizer = SherpaOnnxDiarizer()
    assert diarizer.name == SHERPA_BACKEND_NAME

    result = diarizer.diarize(wav)  # NO hf_token — that's the point.
    assert result.diarized, f"diarization degraded: {result.note!r}"
    assert result.turns, "expected at least one speaker turn"
    for t in result.turns:
        assert isinstance(t, SpeakerTurn)
        assert t.end > t.start >= 0.0
        assert t.speaker
    # Turns are time-ordered (deterministic ordering for idempotency).
    starts = [t.start for t in result.turns]
    assert starts == sorted(starts)


def test_real_sherpa_distinguishes_multiple_speakers_and_aligns():
    _require_models()
    wav = _real_wav()
    result = SherpaOnnxDiarizer().diarize(wav)
    assert result.diarized, f"diarization degraded: {result.note!r}"

    distinct = {t.speaker for t in result.turns}
    assert len(distinct) >= 2, f"expected >=2 remote speakers, got {distinct}"

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


def test_real_sherpa_is_idempotent():
    _require_models()
    wav = _real_wav()
    diarizer = SherpaOnnxDiarizer()
    a = diarizer.diarize(wav)
    b = diarizer.diarize(wav)
    assert a.diarized and b.diarized
    key_a = [(round(t.start, 3), round(t.end, 3), t.speaker) for t in a.turns]
    key_b = [(round(t.start, 3), round(t.end, 3), t.speaker) for t in b.turns]
    assert key_a == key_b
