"""Tests for the ASR backend seam (PRD-2).

Two tiers:

* **Hermetic** (always run): :class:`FakeAsrBackend` determinism + conformance to
  the :class:`AsrBackend` protocol, and the cheap, import-light construction +
  ``status`` surface of the real :class:`FasterWhisperBackend` (NO model load, NO
  network — faster-whisper is imported lazily only inside ``load()``).
* **Real-model smoke** (opt-in, best-effort): generate real speech with macOS
  ``say`` -> 16 kHz mono WAV -> :class:`FasterWhisperBackend` (tiny) -> assert the
  output contains recognizable words. Skipped cleanly unless
  ``LOQUI_RUN_ASR_TESTS`` is set AND ``say`` is available; further skips if the
  tiny model can't be downloaded (no network).
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from fixtures import (  # noqa: E402
    FixtureUnavailable,
    load_wav_pcm,
    say_to_wav,
    silence,
)

from loqui_sidecar.transcription import AsrBackend, AsrToken, FakeAsrBackend  # noqa: E402
from loqui_sidecar.transcription.asr_backend import FasterWhisperBackend  # noqa: E402

# -- FakeAsrBackend: hermetic determinism + conformance ----------------------


def test_fake_backend_conforms_to_protocol():
    assert isinstance(FakeAsrBackend(), AsrBackend)


def test_fake_backend_load_is_idempotent():
    backend = FakeAsrBackend()
    assert backend.is_loaded is False
    backend.load()
    backend.load()
    assert backend.is_loaded is True
    assert backend.name == "fake"


def test_fake_backend_is_deterministic_for_scripted_decodes():
    script = lambda i, n: [AsrToken(text=f"w{i}", t_start=float(i), t_end=i + 0.5)]  # noqa: E731
    a = FakeAsrBackend(script=script)
    b = FakeAsrBackend(script=script)
    # Same decode index -> identical tokens across independent instances.
    out_a = [a.transcribe(b"\x00" * 640) for _ in range(3)]
    out_b = [b.transcribe(b"\x00" * 640) for _ in range(3)]
    assert out_a == out_b
    assert out_a[0] == [AsrToken("w0", 0.0, 0.5)]
    assert out_a[2] == [AsrToken("w2", 2.0, 2.5)]


def test_fake_backend_tracks_decode_count_and_bytes():
    backend = FakeAsrBackend()
    backend.transcribe(b"\x00" * 640)
    backend.transcribe(b"\x00" * 320)
    assert backend.decode_count == 2
    assert backend.total_pcm_bytes == 960


def test_fake_backend_default_script_is_silent():
    backend = FakeAsrBackend()
    assert backend.transcribe(silence(100)) == []


def test_fake_backend_does_not_mutate_pcm():
    pcm = bytearray(b"\x01\x02" * 100)
    snapshot = bytes(pcm)
    FakeAsrBackend(script=lambda i, n: [AsrToken("x", 0.0, 0.1)]).transcribe(bytes(pcm))
    assert bytes(pcm) == snapshot


def test_fake_backend_custom_name():
    assert FakeAsrBackend(name="scripted").name == "scripted"


# -- FasterWhisperBackend: cheap construction + status (NO model load) -------


def test_faster_whisper_conforms_to_protocol_without_loading():
    backend = FasterWhisperBackend(model_size="tiny")
    assert isinstance(backend, AsrBackend)
    assert backend.is_loaded is False  # construction must not load a model


def test_faster_whisper_name_encodes_size_and_compute_type():
    backend = FasterWhisperBackend(model_size="small", compute_type="int8")
    assert backend.name == "faster-whisper:small:int8"


def test_faster_whisper_status_unloaded_then_reports_fields():
    backend = FasterWhisperBackend(model_size="tiny", device="cpu", compute_type="int8")
    st = backend.status
    assert st["state"] == "unloaded"
    assert st["model_size"] == "tiny"
    assert st["device"] == "cpu"
    assert st["compute_type"] == "int8"
    assert st["error"] is None
    assert st["name"] == backend.name


def test_faster_whisper_models_dir_honors_data_dir_env(tmp_path, monkeypatch):
    monkeypatch.setenv("LOQUI_DATA_DIR", str(tmp_path))
    backend = FasterWhisperBackend(model_size="tiny")
    # The resolved download_root must live UNDER the pinned data dir / models.
    assert str(tmp_path) in backend._download_root
    assert backend._download_root.endswith("models")


def test_faster_whisper_does_not_import_faster_whisper_at_construction():
    # Importing the module + constructing the backend must NOT pull faster_whisper
    # into sys.modules (it is lazy, inside load()). This keeps the gate offline.
    # (If a previous test already loaded it, just assert construction is cheap.)
    before = "faster_whisper" in sys.modules
    FasterWhisperBackend(model_size="tiny")
    after = "faster_whisper" in sys.modules
    assert after == before  # construction changed nothing


# -- Real-model smoke (opt-in, best-effort) ----------------------------------

_RUN_REAL = bool(os.environ.get("LOQUI_RUN_ASR_TESTS")) and shutil.which("say") is not None


@pytest.mark.skipif(
    not _RUN_REAL,
    reason="real-model ASR smoke is opt-in; set LOQUI_RUN_ASR_TESTS=1 (and macOS `say` required)",
)
def test_real_faster_whisper_transcribes_say_speech(tmp_path):
    try:
        wav = say_to_wav("the quick brown fox", tmp_path / "speech.wav")
    except (FixtureUnavailable, Exception) as exc:  # noqa: BLE001 - tooling gap.
        pytest.skip(f"could not synthesize speech fixture: {exc}")

    pcm = load_wav_pcm(wav)

    backend = FasterWhisperBackend(
        model_size="tiny",
        device="cpu",
        compute_type="int8",
        models_dir=tmp_path / "models",
    )
    try:
        backend.load()
    except Exception as exc:  # noqa: BLE001 - no network / model unavailable.
        pytest.skip(f"tiny model unavailable (likely no network): {exc}")

    assert backend.is_loaded is True
    assert backend.status["state"] == "loaded"

    tokens = backend.transcribe(pcm, sample_rate=16000, language="en")
    text = " ".join(t.text for t in tokens).lower()
    assert any(word in text for word in ("quick", "brown", "fox")), text
    # Word timestamps are buffer-relative + ordered.
    assert all(t.t_end >= t.t_start for t in tokens)
