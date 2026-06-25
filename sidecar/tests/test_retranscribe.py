"""High-accuracy re-transcription (PRD-2 two-tier) — hermetic unit gate.

Drives :func:`loqui_sidecar.postprocess.retranscribe.re_transcribe_meeting` with
an INJECTED fake segment backend (no model, no network) and tiny real WAV
fixtures, and checks the runner wiring: the ``transcription`` jobUpdate fires
before diarization and the structured-transcript reader PREFERS the hi-fi pass.

Every test points ``LOQUI_DATA_DIR`` at a pytest ``tmp_path`` so nothing touches
the real ``~/Loqui``.
"""

from __future__ import annotations

import json
import struct
import wave
from pathlib import Path

import pytest

from loqui_sidecar.postprocess import runner as runner_mod
from loqui_sidecar.postprocess.request import PostProcessRequest
from loqui_sidecar.postprocess.retranscribe import (
    RetranscribeResult,
    re_transcribe_meeting,
)
from loqui_sidecar.postprocess.runner import _read_structured_transcript, run_postprocess
from loqui_sidecar.postprocess.writers import (
    hifi_jsonl_path,
    hifi_md_path,
    render_hifi_jsonl,
    render_hifi_md,
)
from loqui_sidecar.providers import FAKE_CHAT_ENV, ProviderConfig
from loqui_sidecar.providers import transcript as transcript_mod


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "Loqui"
    root.mkdir()
    monkeypatch.setenv(transcript_mod.DATA_DIR_ENV, str(root))
    monkeypatch.setenv(FAKE_CHAT_ENV, "1")
    return root


def _write_wav(path: Path, n_frames: int = 1600) -> None:
    """Write a tiny 16 kHz mono pcm_s16le WAV of non-silent samples."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(struct.pack("<%dh" % n_frames, *([1000] * n_frames)))


class FakeSegBackend:
    """Scripted segment backend: one segment list per ``transcribe_segments`` call."""

    def __init__(self, scripts: list[list[tuple[float, float, str]]], lang: str = "en") -> None:
        self._scripts = scripts
        self._lang = lang
        self.calls: list[tuple[int, object]] = []

    def transcribe_segments(self, pcm, *, language=None):
        i = len(self.calls)
        self.calls.append((len(pcm), language))
        segs = self._scripts[i] if i < len(self._scripts) else []
        return segs, self._lang


def _audio_dir(data_dir: Path, meeting_id: str) -> Path:
    return data_dir / "meetings" / meeting_id / "audio"


# --- re_transcribe_meeting ----------------------------------------------------


def test_produces_merged_time_ordered_hifi_transcript(data_dir):
    adir = _audio_dir(data_dir, "m1")
    _write_wav(adir / "mic.wav")
    _write_wav(adir / "system.wav")
    backend = FakeSegBackend(
        scripts=[
            [(0.0, 1.0, "mic one")],
            [(0.5, 1.5, "sys one"), (2.0, 3.0, "sys two")],
        ],
        lang="en",
    )

    res = re_transcribe_meeting("m1", backend=backend)

    assert res.produced is True
    assert res.failed is False
    assert res.segment_count == 3
    assert res.language == "en"
    # mic + system both contributed.
    assert set(res.sources) == {"mic", "system"}
    # Language detected on the FIRST call (None) then PINNED for the second.
    assert backend.calls[0][1] is None
    assert backend.calls[1][1] == "en"

    # Structured jsonl: merged, time-sorted, stable hifi ids, correct sources.
    recs = [
        json.loads(line)
        for line in hifi_jsonl_path("m1").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [r["segId"] for r in recs] == ["hifi-0", "hifi-1", "hifi-2"]
    assert [r["text"] for r in recs] == ["mic one", "sys one", "sys two"]
    assert [r["source"] for r in recs] == ["mic", "system", "system"]
    assert [r["tStart"] for r in recs] == [0.0, 0.5, 2.0]

    # Markdown mirrors transcript.live.md exactly (You/They said: + hh:mm:ss).
    md = hifi_md_path("m1").read_text(encoding="utf-8")
    assert md == (
        "[00:00:00] You said: mic one\n"
        "[00:00:00] They said: sys one\n"
        "[00:00:02] They said: sys two\n"
    )


def test_skips_gracefully_when_no_audio(data_dir):
    # No WAVs written (privacy mode / not persisted).
    res = re_transcribe_meeting("m-empty", backend=FakeSegBackend(scripts=[]))
    assert res.produced is False
    assert res.failed is False  # benign skip, not a failure
    assert not hifi_jsonl_path("m-empty").exists()


def test_decode_crash_degrades_to_failed(data_dir):
    adir = _audio_dir(data_dir, "m2")
    _write_wav(adir / "mic.wav")

    class BoomBackend:
        def transcribe_segments(self, pcm, *, language=None):
            raise RuntimeError("decode boom")

    res = re_transcribe_meeting("m2", backend=BoomBackend())
    assert res.produced is False
    assert res.failed is True
    assert not hifi_jsonl_path("m2").exists()


def test_no_speech_is_benign_skip(data_dir):
    adir = _audio_dir(data_dir, "m3")
    _write_wav(adir / "mic.wav")
    res = re_transcribe_meeting("m3", backend=FakeSegBackend(scripts=[[]]))
    assert res.produced is False
    assert res.failed is False
    assert not hifi_jsonl_path("m3").exists()


# --- writers render helpers ---------------------------------------------------


def test_render_helpers_match_live_format():
    recs = [
        {"segId": "hifi-0", "source": "mic", "tStart": 4.0, "tEnd": 5.0, "text": "hello there"},
        {"segId": "hifi-1", "source": "system", "tStart": 67.0, "tEnd": 68.0, "text": "loud and clear"},
    ]
    assert render_hifi_md(recs) == (
        "[00:00:04] You said: hello there\n[00:01:07] They said: loud and clear\n"
    )
    lines = render_hifi_jsonl(recs).splitlines()
    assert json.loads(lines[0]) == {
        "segId": "hifi-0",
        "source": "mic",
        "tStart": 4.0,
        "tEnd": 5.0,
        "text": "hello there",
    }


# --- runner wiring ------------------------------------------------------------


def _seed_live(data_dir: Path, meeting_id: str, recs: list[dict]) -> Path:
    mdir = data_dir / "meetings" / meeting_id
    mdir.mkdir(parents=True, exist_ok=True)
    (mdir / "transcript.live.md").write_text("You: hi\n", encoding="utf-8")
    (mdir / "transcript.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in recs), encoding="utf-8"
    )
    return mdir


def test_read_structured_prefers_hifi_over_live(data_dir):
    live = [{"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "live text"}]
    _seed_live(data_dir, "m1", live)
    # Write a hi-fi jsonl alongside the live one.
    from loqui_sidecar.postprocess.writers import write_hifi_transcript

    write_hifi_transcript(
        "m1",
        [{"segId": "hifi-0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "accurate text"}],
    )
    recs = _read_structured_transcript("m1")
    assert [r.text for r in recs] == ["accurate text"]


def test_runner_emits_transcription_job_before_diarization(data_dir, monkeypatch):
    _seed_live(
        data_dir,
        "m1",
        [{"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "live"}],
    )

    def fake_retranscribe(meeting_id, **kw):
        # Stand in for a successful pass (no real model in the gate).
        from loqui_sidecar.postprocess.writers import write_hifi_transcript

        write_hifi_transcript(
            meeting_id,
            [{"segId": "hifi-0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "hifi"}],
        )
        return RetranscribeResult(produced=True, segment_count=1, language="en", sources=["mic"])

    monkeypatch.setattr(runner_mod, "re_transcribe_meeting", fake_retranscribe)
    monkeypatch.setenv("LOQUI_FAKE_DIARIZER", "1")

    events: list[tuple[str, dict]] = []
    run_postprocess(
        PostProcessRequest(meeting_id="m1", config=ProviderConfig(provider="fake"), re_transcribe=True),
        lambda e, d: events.append((e, d)),
    )

    kinds = [d.get("kind") for e, d in events if e == "jobUpdate"]
    # transcription job is emitted, and BEFORE diarization.
    assert "transcription" in kinds
    assert kinds.index("transcription") < kinds.index("diarization")
    tx = [d for e, d in events if e == "jobUpdate" and d.get("kind") == "transcription"]
    assert [d["state"] for d in tx] == ["running", "done"]


def test_runner_skips_retranscription_when_flag_off(data_dir, monkeypatch):
    _seed_live(
        data_dir,
        "m1",
        [{"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "live"}],
    )
    called = {"n": 0}

    def fake_retranscribe(meeting_id, **kw):
        called["n"] += 1
        return RetranscribeResult(produced=True)

    monkeypatch.setattr(runner_mod, "re_transcribe_meeting", fake_retranscribe)
    monkeypatch.setenv("LOQUI_FAKE_DIARIZER", "1")

    events: list[tuple[str, dict]] = []
    run_postprocess(
        PostProcessRequest(meeting_id="m1", config=ProviderConfig(provider="fake")),  # re_transcribe defaults False
        lambda e, d: events.append((e, d)),
    )
    assert called["n"] == 0
    kinds = [d.get("kind") for e, d in events if e == "jobUpdate"]
    assert "transcription" not in kinds
