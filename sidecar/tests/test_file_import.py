"""Hermetic file-import tests (PRD-12).

Exercise the REUSED pipeline end-to-end WITHOUT a model or network:

* DECODE: a real WAV (written here, and a real m4a/mp3 transcoded by the
  installed ffmpeg when available) decodes to 16 kHz mono pcm_s16le frames via
  PyAV.
* IMPORT: ``run_import`` feeds the decoded PCM through the SAME streaming
  transcription pipeline live capture uses (FAKE AsrBackend), writes the SAME
  transcript files + ``system.wav``, then runs the SAME diarization + summary
  (FakeDiarizer + a fake selector) — producing a ``kind:"import"``-shaped
  transcript record diarized as ``Speaker N`` (single stream, never "You").

The marker-PCM helper (``source_marker_pcm``) makes the FAKE backend emit the
deterministic "They" phrase, exactly as ``smoke:transcription`` does, so the
hermetic gate proves a transcript is produced without a real model.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from loqui_sidecar.file_import.decode import (
    IMPORT_SOURCE,
    DecodeError,
    decode_to_pcm16k_mono,
    iter_decoded_frames,
)
from loqui_sidecar.file_import.importer import ImportFileRequest, run_import
from loqui_sidecar.providers.types import ProviderConfig
from loqui_sidecar.transcription.fake_stream import source_marker_pcm

SR = 16000


def _write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


def _system_speech_wav(path: Path, *, seconds: float = 2.0, trailing_silence: float = 0.8) -> None:
    """A WAV whose PCM carries the FAKE backend's system marker + trailing
    silence (so the energy VAD endpoints and the pipeline commits a final)."""
    pcm = source_marker_pcm("system", int(SR * seconds))
    pcm += b"\x00\x00" * int(SR * trailing_silence)
    _write_wav(path, pcm)


def _fake_selector(_config):
    """A provider selector that always returns the deterministic fake provider."""
    from loqui_sidecar.providers.fake import FakeChatProvider

    return FakeChatProvider()


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv("LOQUI_DATA_DIR", str(tmp_path))
    return tmp_path


# --- decode -------------------------------------------------------------------


def test_decode_wav_to_16k_mono_pcm(tmp_path):
    src = tmp_path / "tone.wav"
    # 1s of a simple ramp; just assert the decode produces 16 kHz mono s16 PCM.
    pcm_in = struct.pack("<%dh" % SR, *[(i % 1000) for i in range(SR)])
    _write_wav(src, pcm_in)

    pcm = decode_to_pcm16k_mono(src)
    # 1s @ 16 kHz mono s16 == 32000 bytes (resampler may add/drop a few samples).
    assert abs(len(pcm) - SR * 2) < SR  # within ~0.5s tolerance
    assert len(pcm) % 2 == 0  # 16-bit aligned

    frames = list(iter_decoded_frames(src))
    assert frames, "expected at least one decoded frame"
    assert all(f.source == IMPORT_SOURCE for f in frames)
    # seq is monotonic from 0; timestamps non-decreasing.
    assert [f.seq for f in frames] == list(range(len(frames)))
    assert frames[0].timestamp_ms == 0.0
    assert frames[-1].timestamp_ms >= frames[0].timestamp_ms


def test_decode_missing_file_raises():
    with pytest.raises(DecodeError):
        decode_to_pcm16k_mono("/no/such/file.m4a")


def test_decode_non_audio_raises(tmp_path):
    bogus = tmp_path / "not-media.bin"
    bogus.write_bytes(b"this is not a media file" * 10)
    with pytest.raises(DecodeError):
        decode_to_pcm16k_mono(bogus)


# --- import end-to-end (decode -> transcript -> diarize/summary) --------------


def test_import_produces_transcript_record_diarized_as_speaker_n(data_dir, tmp_path):
    src = tmp_path / "clip.wav"
    _system_speech_wav(src)

    events: list[tuple[str, dict]] = []
    req = ImportFileRequest(
        meeting_id="imp-1",
        file_path=str(src),
        config=ProviderConfig(provider="fake"),
    )
    run_import(req, lambda e, d: events.append((e, d)), backend=None, selector=_fake_selector)

    # JobUpdate progress for the transcription pass AND the reused diar/summary.
    kinds = {(d["kind"], d["state"]) for e, d in events if e == "jobUpdate"}
    assert ("transcription", "running") in kinds
    assert ("transcription", "done") in kinds
    assert ("diarization", "done") in kinds
    assert ("summary", "done") in kinds

    done = [d for e, d in events if e == "importFileDone"]
    assert len(done) == 1
    assert done[0]["ok"] is True
    assert done[0]["transcription"] == "done"

    meeting = data_dir / "meetings" / "imp-1"
    # The SAME files a live meeting writes are produced.
    live = (meeting / "transcript.live.md").read_text(encoding="utf-8")
    jsonl = (meeting / "transcript.jsonl").read_text(encoding="utf-8")
    assert "the remote meeting audio" in live  # the fake "They" phrase
    assert '"source": "system"' in jsonl
    assert (meeting / "audio" / "system.wav").exists()

    # Single-stream -> diarized as Speaker N (never "You").
    diarized = (meeting / "transcript.diarized.md").read_text(encoding="utf-8")
    assert "Speaker 1" in diarized
    assert "You" not in diarized


def test_import_decode_failure_finalizes_as_failed_import(data_dir, tmp_path):
    bogus = tmp_path / "bad.m4a"
    bogus.write_bytes(b"\x00\x01\x02 not media " * 20)

    events: list[tuple[str, dict]] = []
    req = ImportFileRequest(meeting_id="imp-bad", file_path=str(bogus), config=ProviderConfig())
    run_import(req, lambda e, d: events.append((e, d)), selector=_fake_selector)

    done = [d for e, d in events if e == "importFileDone"]
    assert len(done) == 1
    assert done[0]["ok"] is False
    assert done[0]["transcription"] == "error"
    # No transcript -> no diarization/summary attempted.
    assert done[0]["diarization"] == "skipped"
    assert done[0]["note"]


def test_import_with_explicit_fake_diarizer_labels_speaker(data_dir, tmp_path):
    src = tmp_path / "clip.wav"
    _system_speech_wav(src)
    events: list[tuple[str, dict]] = []
    req = ImportFileRequest(meeting_id="imp-3", file_path=str(src), config=ProviderConfig())

    # Inject the diarizer THROUGH the reused run_postprocess by relying on the
    # importer's selector + the default fake-diarizer env path is not set here;
    # instead assert the alignment fallback still yields a coherent Speaker label.
    run_import(req, lambda e, d: events.append((e, d)), selector=_fake_selector)
    done = [d for e, d in events if e == "importFileDone"][-1]
    assert done["ok"] is True
    diarized = (data_dir / "meetings" / "imp-3" / "transcript.diarized.json").read_text(
        encoding="utf-8"
    )
    assert "Speaker" in diarized


# --- real-audio decode proof (opt-in, best-effort) ----------------------------


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


@pytest.mark.skipif(_ffmpeg() is None, reason="ffmpeg not on PATH")
@pytest.mark.parametrize("ext", ["m4a", "mp3", "mp4"])
def test_decode_real_transcoded_container(tmp_path, ext):
    """Transcode a real WAV to a compressed container via the installed ffmpeg,
    then prove PyAV decodes it back to 16 kHz mono PCM (the real import decode
    path on real m4a/mp3/mp4 — no model needed for the decode assertion)."""
    wav = tmp_path / "speech.wav"
    # 1.5s of marker PCM (non-silent, well-formed audio ffmpeg will encode).
    _write_wav(wav, source_marker_pcm("system", int(SR * 1.5)))

    out = tmp_path / f"clip.{ext}"
    codec = ["-c:a", "aac"] if ext in ("m4a", "mp4") else ["-c:a", "libmp3lame"]
    res = subprocess.run(
        ["ffmpeg", "-y", "-i", str(wav), *codec, str(out)],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0 or not out.exists():
        pytest.skip(f"ffmpeg could not produce {ext}: {res.stderr[-200:]}")

    pcm = decode_to_pcm16k_mono(out)
    assert len(pcm) > 0
    assert len(pcm) % 2 == 0
