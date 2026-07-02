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
    _backend_cache,
    _cached_faster_whisper_backend,
    _reset_backend_cache,
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
        {
            "segId": "hifi-1",
            "source": "system",
            "tStart": 67.0,
            "tEnd": 68.0,
            "text": "loud and clear",
        },
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
    # NO live finals (transcription produced nothing) -> the re-transcription pass
    # is the only way to get a transcript, so it genuinely RUNS here.
    _seed_live(data_dir, "m1", [])
    called = {"n": 0}

    def fake_retranscribe(meeting_id, **kw):
        # Stand in for a successful pass (no real model in the gate).
        called["n"] += 1
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
        PostProcessRequest(
            meeting_id="m1", config=ProviderConfig(provider="fake"), re_transcribe=True
        ),
        lambda e, d: events.append((e, d)),
    )

    assert called["n"] == 1  # the pass actually ran (no live finals to trust)
    kinds = [d.get("kind") for e, d in events if e == "jobUpdate"]
    # transcription job is emitted, and BEFORE diarization.
    assert "transcription" in kinds
    assert kinds.index("transcription") < kinds.index("diarization")
    tx = [d for e, d in events if e == "jobUpdate" and d.get("kind") == "transcription"]
    assert [d["state"] for d in tx] == ["running", "done"]


def test_runner_skips_retranscription_when_live_finals_exist(data_dir, monkeypatch):
    """The big win: when the live transcript already holds accurate finals, the
    re-transcription pass is SKIPPED entirely (it is strictly lower quality than
    the live finals) — but the transcription JOB still terminates running->done so
    the UI never hangs on a phantom stage, and alignment/summary run on the live
    finals."""
    _seed_live(
        data_dir,
        "m1",
        [
            {
                "segId": "s0",
                "source": "mic",
                "tStart": 0.0,
                "tEnd": 1.0,
                "text": "accurate live text",
            }
        ],
    )
    called = {"n": 0}

    def fake_retranscribe(meeting_id, **kw):
        called["n"] += 1
        return RetranscribeResult(produced=True)

    monkeypatch.setattr(runner_mod, "re_transcribe_meeting", fake_retranscribe)
    monkeypatch.setenv("LOQUI_FAKE_DIARIZER", "1")

    events: list[tuple[str, dict]] = []
    run_postprocess(
        PostProcessRequest(
            meeting_id="m1", config=ProviderConfig(provider="fake"), re_transcribe=True
        ),
        lambda e, d: events.append((e, d)),
    )

    # The expensive pass was NOT invoked...
    assert called["n"] == 0
    # ...yet the transcription JOB still fired running -> done (no phantom stage).
    tx = [d for e, d in events if e == "jobUpdate" and d.get("kind") == "transcription"]
    assert [d["state"] for d in tx] == ["running", "done"]
    # No hi-fi transcript was written; alignment used the live finals.
    assert not hifi_jsonl_path("m1").exists()
    done = [d for e, d in events if e == "postProcessDone"][0]
    assert "skipped" in done["note"]
    # The live finals reached the diarized output (proves alignment ran on them).
    from loqui_sidecar.postprocess.writers import diarized_json_path

    doc = json.loads(diarized_json_path("m1").read_text(encoding="utf-8"))
    assert [s["text"] for s in doc["segments"]] == ["accurate live text"]


def test_runner_retranscribes_when_live_finals_are_empty(data_dir, monkeypatch):
    """Edge case: a meeting whose live transcription produced only empty/whitespace
    records is NOT trustworthy -> the re-transcription pass still runs as the
    fallback (so we never ship an empty transcript when audio exists)."""
    _seed_live(
        data_dir,
        "m1",
        [{"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "   "}],
    )
    called = {"n": 0}

    def fake_retranscribe(meeting_id, **kw):
        called["n"] += 1
        return RetranscribeResult(produced=True)

    monkeypatch.setattr(runner_mod, "re_transcribe_meeting", fake_retranscribe)
    monkeypatch.setenv("LOQUI_FAKE_DIARIZER", "1")

    events: list[tuple[str, dict]] = []
    run_postprocess(
        PostProcessRequest(
            meeting_id="m1", config=ProviderConfig(provider="fake"), re_transcribe=True
        ),
        lambda e, d: events.append((e, d)),
    )
    assert called["n"] == 1  # whitespace-only finals don't count -> pass runs


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
        PostProcessRequest(
            meeting_id="m1", config=ProviderConfig(provider="fake")
        ),  # re_transcribe defaults False
        lambda e, d: events.append((e, d)),
    )
    assert called["n"] == 0
    kinds = [d.get("kind") for e, d in events if e == "jobUpdate"]
    assert "transcription" not in kinds


def test_runner_import_path_never_retranscribes(data_dir, monkeypatch):
    """The import contract: file imports call run_postprocess with re_transcribe
    False (the importer transcribed the file up front), so the re-transcription
    pass NEVER runs from run_postprocess even though there are live finals — the
    skip predicate is irrelevant on that path."""
    _seed_live(
        data_dir,
        "m1",
        [{"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 1.0, "text": "imported text"}],
    )
    called = {"n": 0}

    def fake_retranscribe(meeting_id, **kw):
        called["n"] += 1
        return RetranscribeResult(produced=True)

    monkeypatch.setattr(runner_mod, "re_transcribe_meeting", fake_retranscribe)
    monkeypatch.setenv("LOQUI_FAKE_DIARIZER", "1")

    events: list[tuple[str, dict]] = []
    # Mirror the importer's PostProcessRequest (re_transcribe defaults False).
    run_postprocess(
        PostProcessRequest(meeting_id="m1", config=ProviderConfig(provider="fake")),
        lambda e, d: events.append((e, d)),
    )
    assert called["n"] == 0
    # No transcription jobUpdate at all (the pass is not part of this path).
    assert "transcription" not in [d.get("kind") for e, d in events if e == "jobUpdate"]


# --- hi-fi model cache (fallback re-transcription reuses the loaded model) ----


def test_backend_cache_reuses_one_instance_per_key(monkeypatch):
    """Back-to-back fallback re-transcriptions with the same (model, beam, lang)
    reuse the SAME cached backend instead of reloading the whisper weights."""
    _reset_backend_cache()
    built: list[tuple] = []

    class _StubBackend:
        def __init__(self, **kw):
            built.append((kw.get("model_size"), kw.get("beam_size"), kw.get("language")))

        def transcribe_segments(self, pcm, *, language=None):  # pragma: no cover - unused
            return [], language

    import loqui_sidecar.transcription.asr_backend as asr

    monkeypatch.setattr(asr, "FasterWhisperBackend", _StubBackend)

    try:
        b1 = _cached_faster_whisper_backend("small", 3, None)
        b2 = _cached_faster_whisper_backend("small", 3, None)
        assert b1 is b2  # same instance -> loaded once
        assert len(built) == 1

        # A DIFFERENT key (pinned language) gets its own instance (never poisons
        # the common auto-detect None instance).
        b3 = _cached_faster_whisper_backend("small", 3, "es")
        assert b3 is not b1
        assert len(built) == 2
    finally:
        _reset_backend_cache()


def test_re_transcribe_uses_the_cache_by_default(data_dir, monkeypatch):
    """re_transcribe_meeting (no injected backend) pulls from the shared cache, so
    two meetings back-to-back share one loaded model."""
    _reset_backend_cache()

    class _StubBackend:
        instances = 0

        def __init__(self, **kw):
            type(self).instances += 1

        def transcribe_segments(self, pcm, *, language=None):
            return [(0.0, 1.0, "hi")], "en"

    import loqui_sidecar.transcription.asr_backend as asr

    monkeypatch.setattr(asr, "FasterWhisperBackend", _StubBackend)

    adir1 = _audio_dir(data_dir, "c1")
    _write_wav(adir1 / "mic.wav")
    adir2 = _audio_dir(data_dir, "c2")
    _write_wav(adir2 / "mic.wav")

    try:
        r1 = re_transcribe_meeting("c1")
        r2 = re_transcribe_meeting("c2")
        assert r1.produced and r2.produced
        # Exactly ONE model constructed across both meetings (cache reuse).
        assert _StubBackend.instances == 1
        assert len(_backend_cache) == 1
    finally:
        _reset_backend_cache()
