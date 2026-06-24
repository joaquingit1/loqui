"""Hermetic unit tests for the diarization engine + the diarized-file writer (PRD-5).

Everything here is hermetic by construction: NO torch / pyannote / HF token /
audio device / network, and every disk write goes to a pytest ``tmp_path`` via
``LOQUI_DATA_DIR`` so nothing touches the real ``~/Loqui``.

Covered:
* FakeDiarizer determinism (fixed script + WAV-length-derived script + fixture override).
* PyannoteDiarizer GRACEFUL DEGRADATION (no WAV / no token / torch absent) — never
  raises; never leaks the HF token into the note.
* the diarized-transcript writer: JSON+MD round-trip, the ``[hh:mm:ss] who: text``
  render, atomic idempotent replace.
"""

from __future__ import annotations

import json
import struct
import wave
from pathlib import Path

import pytest

from loqui_sidecar.postprocess import (
    SPEAKER_YOU_LABEL,
    DiarizationResult,
    DiarizationUnavailable,
    DiarizedSegment,
    DiarizedTranscript,
    FakeDiarizer,
    PYANNOTE_PIPELINE,
    PyannoteDiarizer,
    SpeakerTurn,
    default_diarizer,
    diarized_json_path,
    diarized_md_path,
    render_diarized_md,
    scripted_turns,
    write_diarized_transcript,
)


@pytest.fixture(autouse=True)
def _hermetic_data_dir(tmp_path, monkeypatch):
    """Point the derived-file writer at a temp data root (never the real ~/Loqui)."""
    monkeypatch.setenv("LOQUI_DATA_DIR", str(tmp_path))
    return tmp_path


def _write_wav(path: Path, seconds: float, rate: int = 8000) -> None:
    """Write a tiny silent mono WAV of ``seconds`` duration (stdlib only)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<%dh" % n, *([0] * n)))


# --- FakeDiarizer -------------------------------------------------------------


def test_fake_diarizer_default_script_is_deterministic():
    a = FakeDiarizer().diarize("/does/not/exist.wav")
    b = FakeDiarizer().diarize("/does/not/exist.wav")
    assert a.diarized is True and a.backend == "fake"
    assert a.note == ""
    turns_a = [(t.start, t.end, t.speaker) for t in a.turns]
    turns_b = [(t.start, t.end, t.speaker) for t in b.turns]
    assert turns_a == turns_b
    # Fixed 12s / four-turn / two-speaker script when no WAV is present.
    assert turns_a == [
        (0.0, 3.0, "spk_0"),
        (3.0, 6.0, "spk_1"),
        (6.0, 9.0, "spk_0"),
        (9.0, 12.0, "spk_1"),
    ]
    assert len({t.speaker for t in a.turns}) >= 2


def test_fake_diarizer_never_raises_and_ignores_token():
    # An HF token is irrelevant to the fake backend; must not raise or read net.
    r = FakeDiarizer().diarize("/nope.wav", hf_token="hf_secret")
    assert r.diarized is True
    assert "hf_secret" not in (r.note or "")


def test_fake_diarizer_fixture_override_used_verbatim():
    script = [SpeakerTurn(0.0, 1.0, "a"), SpeakerTurn(1.0, 2.0, "b")]
    r = FakeDiarizer(turns=script).diarize("/ignored.wav")
    assert [(t.start, t.end, t.speaker) for t in r.turns] == [
        (0.0, 1.0, "a"),
        (1.0, 2.0, "b"),
    ]


def test_fake_diarizer_derives_script_from_wav_length(tmp_path):
    wav = tmp_path / "system.wav"
    _write_wav(wav, seconds=7.0)
    r = FakeDiarizer().diarize(str(wav))
    assert r.diarized is True
    # ~7s -> 3s + 3s + 1s, alternating two speakers (matches scripted_turns(7)).
    assert [(round(t.start, 2), round(t.end, 2), t.speaker) for t in r.turns] == [
        (0.0, 3.0, "spk_0"),
        (3.0, 6.0, "spk_1"),
        (6.0, 7.0, "spk_0"),
    ]


def test_scripted_turns_guarantees_two_speakers_even_when_short():
    turns = scripted_turns(1.0)
    assert len({t.speaker for t in turns}) >= 2


def test_scripted_turns_nonpositive_collapses_to_fixed_script():
    assert scripted_turns(0.0) == scripted_turns(-5.0)
    assert len(scripted_turns(0.0)) == 4


def test_default_diarizer_is_fake():
    assert default_diarizer().name == "fake"


# --- PyannoteDiarizer: graceful degradation -----------------------------------


def test_pyannote_name_pinned_to_3_1():
    assert PyannoteDiarizer().name == PYANNOTE_PIPELINE
    assert PYANNOTE_PIPELINE == "pyannote/speaker-diarization-3.1"


def test_pyannote_missing_wav_degrades_not_raises():
    r = PyannoteDiarizer().diarize("/no/such/file.wav", hf_token="hf_x")
    assert isinstance(r, DiarizationResult)
    assert r.diarized is False
    assert "not found" in r.note
    assert r.backend == PYANNOTE_PIPELINE


def test_pyannote_no_token_degrades(tmp_path):
    wav = tmp_path / "system.wav"
    _write_wav(wav, seconds=1.0)
    r = PyannoteDiarizer().diarize(str(wav), hf_token=None)
    assert r.diarized is False
    assert "Hugging Face token" in r.note


def test_pyannote_torch_absent_degrades_gracefully(tmp_path):
    """With torch+pyannote NOT installed (the default env), a configured token +
    a real WAV still degrades gracefully (PRD-5 AC#4) — never raises."""
    wav = tmp_path / "system.wav"
    _write_wav(wav, seconds=1.0)
    r = PyannoteDiarizer().diarize(str(wav), hf_token="hf_fake_token")
    assert r.diarized is False
    assert r.turns == []
    assert "not installed" in r.note
    # The HF token must NEVER appear in the user-facing note.
    assert "hf_fake_token" not in r.note


def test_pyannote_never_leaks_token_when_run_helper_fails(tmp_path, monkeypatch):
    """Even when the (stubbed) pipeline-load path raises, the degraded note is
    secret-free and diarize() does not raise."""
    wav = tmp_path / "system.wav"
    _write_wav(wav, seconds=1.0)

    def _boom(Pipeline, torch, wav_path, hf_token):  # noqa: N803
        raise DiarizationUnavailable("could not load the pyannote weights")

    # Force the import guard to pass so _run is reached, then make _run raise.
    monkeypatch.setattr(PyannoteDiarizer, "_run", staticmethod(_boom))
    # Stub the lazy import so we exercise the _run failure branch deterministically.
    import sys
    import types as _t

    fake_pyannote = _t.ModuleType("pyannote")
    fake_audio = _t.ModuleType("pyannote.audio")
    fake_audio.Pipeline = object  # type: ignore[attr-defined]
    fake_pyannote.audio = fake_audio  # type: ignore[attr-defined]
    fake_torch = _t.ModuleType("torch")
    monkeypatch.setitem(sys.modules, "pyannote", fake_pyannote)
    monkeypatch.setitem(sys.modules, "pyannote.audio", fake_audio)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    r = PyannoteDiarizer().diarize(str(wav), hf_token="hf_super_secret")
    assert r.diarized is False
    assert "hf_super_secret" not in r.note
    assert "weights" in r.note


def test_diarization_unavailable_is_runtime_error():
    assert issubclass(DiarizationUnavailable, RuntimeError)


# --- diarized writer: round-trip, render, idempotency -------------------------


def _make_diarized(meeting_id="m1"):
    segs = [
        DiarizedSegment(
            seg_id="s1",
            source="mic",
            text="Hello there",
            t_start=0.0,
            t_end=2.0,
            speaker=SPEAKER_YOU_LABEL,
        ),
        DiarizedSegment(
            seg_id="s2",
            source="system",
            text="Hi, good to meet you",
            t_start=2.0,
            t_end=5.0,
            speaker="Speaker 1",
        ),
        DiarizedSegment(
            seg_id="s3",
            source="system",
            text="Same here",
            t_start=65.0,
            t_end=67.0,
            speaker="Speaker 2",
        ),
    ]
    return DiarizedTranscript(
        meeting_id=meeting_id,
        diarized=True,
        backend="fake",
        speakers=["Speaker 1", "Speaker 2"],
        segments=segs,
    )


def test_render_diarized_md_format():
    md = render_diarized_md(_make_diarized())
    lines = md.splitlines()
    assert lines[0] == "[00:00:00] You: Hello there"
    assert lines[1] == "[00:00:02] Speaker 1: Hi, good to meet you"
    assert lines[2] == "[00:01:05] Speaker 2: Same here"
    assert md.endswith("\n")


def test_render_diarized_md_uses_display_name_when_renamed():
    d = _make_diarized()
    d.segments[1].display_name = "Alice"
    md = render_diarized_md(d)
    assert "[00:00:02] Alice: Hi, good to meet you" in md


def test_render_diarized_md_empty_is_empty_string():
    d = DiarizedTranscript(meeting_id="m1")
    assert render_diarized_md(d) == ""


def test_render_strips_newlines_in_text():
    d = DiarizedTranscript(
        meeting_id="m1",
        segments=[
            DiarizedSegment(
                seg_id="s1",
                source="mic",
                text="line one\nline two\r\nthree",
                t_start=0.0,
                t_end=1.0,
            )
        ],
    )
    md = render_diarized_md(d)
    # No raw newline survives inside a rendered line (each \r and \n -> a space).
    assert "\n" not in md.rstrip("\n")
    assert "\r" not in md
    assert "line one" in md and "three" in md


def test_write_diarized_transcript_roundtrip():
    d = _make_diarized("meet-abc")
    write_diarized_transcript(d)
    jpath = diarized_json_path("meet-abc")
    mpath = diarized_md_path("meet-abc")
    assert jpath.exists() and mpath.exists()

    loaded = json.loads(jpath.read_text(encoding="utf-8"))
    assert loaded["meetingId"] == "meet-abc"
    assert loaded["diarized"] is True
    assert loaded["backend"] == "fake"
    assert loaded["speakers"] == ["Speaker 1", "Speaker 2"]
    assert [s["speaker"] for s in loaded["segments"]] == [
        SPEAKER_YOU_LABEL,
        "Speaker 1",
        "Speaker 2",
    ]
    assert loaded["segments"][0]["segId"] == "s1"
    assert loaded["segments"][0]["displayName"] is None
    # MD matches the pure renderer.
    assert mpath.read_text(encoding="utf-8") == render_diarized_md(d)


def test_write_diarized_transcript_idempotent_replace():
    write_diarized_transcript(_make_diarized("dup"))
    first_json = diarized_json_path("dup").read_text(encoding="utf-8")
    first_md = diarized_md_path("dup").read_text(encoding="utf-8")

    # Re-run with DIFFERENT content: must cleanly REPLACE (no duplication/append).
    d2 = DiarizedTranscript(
        meeting_id="dup",
        diarized=True,
        backend="fake",
        speakers=["Speaker 1"],
        segments=[
            DiarizedSegment(
                seg_id="x",
                source="system",
                text="only one",
                t_start=0.0,
                t_end=1.0,
                speaker="Speaker 1",
            )
        ],
    )
    write_diarized_transcript(d2)
    second_json = json.loads(diarized_json_path("dup").read_text(encoding="utf-8"))
    second_md = diarized_md_path("dup").read_text(encoding="utf-8")

    assert len(second_json["segments"]) == 1
    assert second_json["segments"][0]["segId"] == "x"
    assert second_md == "[00:00:00] Speaker 1: only one\n"
    # Re-running the SAME content twice yields byte-identical output (idempotent).
    write_diarized_transcript(_make_diarized("dup"))
    assert diarized_json_path("dup").read_text(encoding="utf-8") == first_json
    assert diarized_md_path("dup").read_text(encoding="utf-8") == first_md


def test_write_diarized_transcript_leaves_no_temp_files(tmp_path):
    write_diarized_transcript(_make_diarized("clean"))
    meeting_dir = diarized_json_path("clean").parent
    leftovers = [p.name for p in meeting_dir.iterdir() if p.name.startswith(".tmp-")]
    assert leftovers == []


def test_writer_rejects_unsafe_meeting_id():
    with pytest.raises(ValueError):
        diarized_json_path("../escape")
    with pytest.raises(ValueError):
        write_diarized_transcript(DiarizedTranscript(meeting_id=".."))
