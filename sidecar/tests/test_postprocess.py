"""Hermetic unit tests for the sidecar post-process coordinator (PRD-5).

Scope: ``loqui_sidecar.postprocess.run_postprocess`` — the orchestrator that, on
a ``postProcess`` request, runs DIARIZATION (on ``system.wav`` only) + ALIGNMENT
(pure, over the READ-ONLY ``transcript.jsonl``) + the AI SUMMARY (reusing the
PRD-4 provider READ-ONLY over ``transcript.live.md``), emitting ``jobUpdate``
progress + a terminal ``postProcessDone``.

Everything here is hermetic by construction — NO network, NO API key, NO torch,
NO pyannote, NO HF token, NO audio device:

* every test points ``LOQUI_DATA_DIR`` at a pytest ``tmp_path`` so nothing
  touches the real ``~/Loqui``;
* the diarizer is injected (the deterministic :class:`FakeDiarizer`, or — for the
  graceful-degradation test — the real :class:`PyannoteDiarizer` with torch/HF
  absent, which returns ``diarized=False`` rather than raising);
* the summary provider is the deterministic :class:`FakeChatProvider` (forced via
  ``LOQUI_FAKE_CHAT`` and/or an injected selector) — no real provider call;
* ``emit`` is captured into an in-memory list so we assert the exact
  ``jobUpdate`` / ``postProcessDone`` notification sequence.

The headline assertion is the CROSS-CUTTING INVARIANT: **the AI never edits the
transcript.** A full diarize+summary run leaves ``transcript.live.md`` and
``transcript.jsonl`` byte-for-byte identical; the diarized + summary outputs are
SEPARATE derived files.

Required scenarios (per the build-unit brief):
1. full run -> diarization JobUpdates + transcript.diarized written + summary
   JobUpdates + summary.json + postProcessDone with speakers/summary;
2. torch-absent path -> diarization "skipped" (degraded) but summary still runs
   + the pipeline completes;
3. summary-provider error -> diarization still done, summary error reported, no
   crash, postProcessDone still emitted.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Iterator, Optional

import pytest

from loqui_sidecar.postprocess import (
    FAKE_DIARIZER_ENV,
    JOB_KIND_DIARIZATION,
    JOB_KIND_SUMMARY,
    JOB_UPDATE_EVENT,
    POSTPROCESS_DONE_EVENT,
    SUMMARY_TOKEN_EVENT,
    SPEAKER_LABEL_PREFIX,
    SPEAKER_YOU_LABEL,
    FakeDiarizer,
    PostProcessRequest,
    PyannoteDiarizer,
    SpeakerTurn,
    run_postprocess,
)
from loqui_sidecar.providers import (
    FAKE_CHAT_ENV,
    ChatMessage,
    ChatProviderError,
    ProviderConfig,
)
from loqui_sidecar.providers import transcript as transcript_mod

# --- fixtures + helpers -------------------------------------------------------

#: A live transcript used for the summary context (the read-only grounding the
#: provider receives). Distinctive markers let us assert it reached the summary.
SAMPLE_LIVE = (
    "## Live transcript\n\n"
    "You: We agreed to ship the Falcon-7 release on Friday.\n"
    "They: I'll own the migration. Action item: write the runbook.\n"
    "You: Great, let's sync again Thursday.\n"
)

#: Structured records aligned to the FakeDiarizer's notional 12s timeline
#: (spk_0 0-3 + 6-9, spk_1 3-6 + 9-12). One mic ("You") segment + three system
#: ("They") segments that fall in spk_0 / spk_1 / spk_0 windows respectively, so
#: alignment must yield You, Speaker 1, Speaker 2, Speaker 1.
SAMPLE_RECORDS = [
    {"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 2.5, "text": "hello team"},
    {"segId": "s1", "source": "system", "tStart": 0.5, "tEnd": 2.8, "text": "remote one"},
    {"segId": "s2", "source": "system", "tStart": 3.5, "tEnd": 5.5, "text": "remote two"},
    {"segId": "s3", "source": "system", "tStart": 6.5, "tEnd": 8.5, "text": "remote one again"},
]


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    """A hermetic temp data root. Points ``LOQUI_DATA_DIR`` at it so the on-disk
    reader/writers never touch the real ``~/Loqui``. Forces the FAKE chat
    provider (so the summary step needs no network/key) and clears the
    fake-diarizer flag (each test injects its diarizer explicitly).
    """
    root = tmp_path / "Loqui"
    root.mkdir()
    monkeypatch.setenv(transcript_mod.DATA_DIR_ENV, str(root))
    monkeypatch.setenv(FAKE_CHAT_ENV, "1")
    monkeypatch.delenv(FAKE_DIARIZER_ENV, raising=False)
    return root


def _seed(
    data_dir: Path,
    meeting_id: str,
    *,
    live: str = SAMPLE_LIVE,
    records: Optional[list[dict]] = None,
    system_wav: bool = False,
) -> Path:
    """Seed a meeting dir with the live transcript + structured jsonl (the
    alignment input) and optionally a stub ``system.wav``. Returns the dir."""
    mdir = data_dir / "meetings" / meeting_id
    mdir.mkdir(parents=True, exist_ok=True)
    (mdir / "transcript.live.md").write_text(live, encoding="utf-8")
    recs = SAMPLE_RECORDS if records is None else records
    (mdir / "transcript.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in recs), encoding="utf-8"
    )
    if system_wav:
        (mdir / "audio").mkdir(exist_ok=True)
        (mdir / "audio" / "system.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    return mdir


def _collect_emit():
    """An ``emit`` callable that records ``(event, data)`` tuples in order."""
    events: list[tuple[str, dict]] = []

    def emit(event: str, data: dict) -> None:
        events.append((event, data))

    return events, emit


def _request(meeting_id: str, *, provider: str = "fake", **kw) -> PostProcessRequest:
    return PostProcessRequest(meeting_id=meeting_id, config=ProviderConfig(provider=provider), **kw)


def _done(events: list[tuple[str, dict]]) -> dict:
    """The single terminal ``postProcessDone`` payload."""
    dones = [d for e, d in events if e == POSTPROCESS_DONE_EVENT]
    assert len(dones) == 1, f"expected exactly one postProcessDone, got {len(dones)}"
    return dones[0]


def _job_updates(events, kind: str) -> list[dict]:
    return [d for e, d in events if e == JOB_UPDATE_EVENT and d.get("kind") == kind]


# --- 1) FULL RUN (the happy path) ---------------------------------------------


def test_full_run_emits_diarization_then_summary_then_done(data_dir):
    """A full fake-backed run: diarization JobUpdates -> summary JobUpdates ->
    one terminal postProcessDone, in order."""
    _seed(data_dir, "m1")
    events, emit = _collect_emit()

    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer())

    # The summary now STREAMS: ``summaryToken`` deltas are interleaved between the
    # summary running+done jobUpdates. Assert the jobUpdate/terminal SKELETON
    # (ignoring the token stream), then check the tokens separately below.
    kinds = [(e, d.get("kind"), d.get("state")) for e, d in events if e != SUMMARY_TOKEN_EVENT]
    assert kinds == [
        (JOB_UPDATE_EVENT, JOB_KIND_DIARIZATION, "running"),
        (JOB_UPDATE_EVENT, JOB_KIND_DIARIZATION, "done"),
        (JOB_UPDATE_EVENT, JOB_KIND_SUMMARY, "running"),
        (JOB_UPDATE_EVENT, JOB_KIND_SUMMARY, "done"),
        (POSTPROCESS_DONE_EVENT, None, None),
    ]
    # Each job carries a jobId + 0..1 progress.
    for e, d in events:
        if e == JOB_UPDATE_EVENT:
            assert d["jobId"]
            assert 0.0 <= d["progress"] <= 1.0

    # The streamed summary tokens arrive WHILE the summary job runs (after its
    # "running" jobUpdate, before its "done"), each tagged with the meeting + job.
    flat = [e for e, _ in events]
    tokens = [(i, d) for i, (e, d) in enumerate(events) if e == SUMMARY_TOKEN_EVENT]
    assert tokens, "expected the summary to stream at least one token"
    for _i, d in tokens:
        assert d["meetingId"] == "m1"
        assert d["jobId"] == "m1:summary"
        assert "delta" in d
    # Tokens fall before the terminal postProcessDone.
    done_idx = flat.index(POSTPROCESS_DONE_EVENT)
    assert all(i < done_idx for i, _ in tokens)


def test_full_run_writes_diarized_transcript(data_dir):
    """Diarization + alignment write transcript.diarized.{json,md} as SEPARATE
    derived files, with mic -> "You" and system segments -> Speaker N by overlap.
    """
    mdir = _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer())

    djson = mdir / "transcript.diarized.json"
    dmd = mdir / "transcript.diarized.md"
    assert djson.exists() and dmd.exists()

    doc = json.loads(djson.read_text(encoding="utf-8"))
    assert doc["meetingId"] == "m1"
    assert doc["diarized"] is True
    assert doc["backend"] == "fake"
    # First-appearance order over the system stream: Speaker 1, then Speaker 2.
    assert doc["speakers"] == [f"{SPEAKER_LABEL_PREFIX} 1", f"{SPEAKER_LABEL_PREFIX} 2"]

    # The re-labeling preserves segment order + ids; mic -> You, system -> overlap.
    by_id = {s["segId"]: s for s in doc["segments"]}
    assert [s["segId"] for s in doc["segments"]] == ["s0", "s1", "s2", "s3"]
    assert by_id["s0"]["speaker"] == SPEAKER_YOU_LABEL  # mic
    assert by_id["s1"]["speaker"] == f"{SPEAKER_LABEL_PREFIX} 1"  # spk_0 window
    assert by_id["s2"]["speaker"] == f"{SPEAKER_LABEL_PREFIX} 2"  # spk_1 window
    assert by_id["s3"]["speaker"] == f"{SPEAKER_LABEL_PREFIX} 1"  # spk_0 again

    md = dmd.read_text(encoding="utf-8")
    assert f"{SPEAKER_YOU_LABEL}: hello team" in md
    assert f"{SPEAKER_LABEL_PREFIX} 2: remote two" in md


def test_full_run_writes_summary(data_dir):
    """The summary step writes summary.json via the PRD-4 fake provider, grounded
    on the read-only transcript."""
    mdir = _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer())

    sjson = mdir / "summary.json"
    assert sjson.exists()
    summary = json.loads(sjson.read_text(encoding="utf-8"))
    assert summary["meetingId"] == "m1"
    assert summary["provider"] == "fake"
    assert summary["model"] == "fake"
    assert summary["generatedAt"]  # stamped by the runner
    # The fake provider emits a "context" marker iff the read-only transcript
    # reached it as grounding context — proves the summary is transcript-grounded.
    # The default summary is now a markdown document, so the (non-JSON) fake
    # output lands in `overview`.
    assert "context" in summary["overview"]
    assert "no-context" not in summary["overview"]


def test_full_run_done_payload_carries_speakers_and_stages(data_dir):
    """postProcessDone hands main everything it needs to index + finalize."""
    _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer())

    done = _done(events)
    assert done["meetingId"] == "m1"
    assert done["diarization"] == "done"
    assert done["summary"] == "done"
    assert done["speakers"] == [f"{SPEAKER_LABEL_PREFIX} 1", f"{SPEAKER_LABEL_PREFIX} 2"]
    assert done["diarizationBackend"] == "fake"
    assert done["summaryProvider"] == "fake"
    assert done["summaryModel"] == "fake"
    # indexText combines the diarized transcript text + the summary so FTS covers
    # both (PRD-5 AC#1: searchable).
    assert "remote two" in done["indexText"]
    assert "context" in done["indexText"]


def test_env_forced_fake_diarizer_no_injection(data_dir, monkeypatch):
    """``LOQUI_FAKE_DIARIZER`` selects the fake even with NO diarizer injected —
    so the gate/smoke stay hermetic via the default factory."""
    monkeypatch.setenv(FAKE_DIARIZER_ENV, "1")
    _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit)  # no diarizer arg -> default factory
    done = _done(events)
    assert done["diarization"] == "done"
    assert done["diarizationBackend"] == "fake"


def test_custom_turns_drive_alignment(data_dir):
    """A scripted FakeDiarizer with a specific turn script drives a known speaker
    attribution — proving alignment uses the injected turns, not a fixed result."""
    records = [
        {"segId": "a", "source": "system", "tStart": 0.0, "tEnd": 1.0, "text": "x"},
        {"segId": "b", "source": "system", "tStart": 5.0, "tEnd": 6.0, "text": "y"},
    ]
    _seed(data_dir, "m1", records=records)
    turns = [
        SpeakerTurn(start=0.0, end=2.0, speaker="A"),
        SpeakerTurn(start=4.0, end=7.0, speaker="B"),
    ]
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer(turns=turns))
    done = _done(events)
    assert done["speakers"] == [f"{SPEAKER_LABEL_PREFIX} 1", f"{SPEAKER_LABEL_PREFIX} 2"]


# --- 2) TORCH-ABSENT / GRACEFUL DEGRADATION -----------------------------------


def test_torch_absent_diarization_skipped_summary_still_runs(data_dir):
    """The real PyannoteDiarizer with torch/pyannote + HF token ABSENT degrades
    gracefully (diarized=False) — diarization is reported "skipped" in the
    terminal payload, but the summary still runs and the pipeline COMPLETES
    (PRD-5 AC#4: meeting still completes with live transcript + summary)."""
    mdir = _seed(data_dir, "m1", system_wav=True)
    events, emit = _collect_emit()

    # Inject the REAL backend; no hf_token on the request -> graceful skip (and
    # even with a token, torch/pyannote are absent in the base env -> skip).
    run_postprocess(_request("m1"), emit, diarizer=PyannoteDiarizer())

    done = _done(events)
    assert done["diarization"] == "skipped"
    assert done["summary"] == "done"  # summary still ran
    assert done["diarizationBackend"] == PyannoteDiarizer.name
    # A secret-free, user-facing reason rides on the note.
    assert done["note"]
    assert "skip" in done["note"].lower()

    # The diarized file is STILL written (degraded -> every system segment gets a
    # coherent fallback "Speaker 1"), so the meeting is coherent + searchable.
    doc = json.loads((mdir / "transcript.diarized.json").read_text(encoding="utf-8"))
    assert doc["diarized"] is False
    sys_speakers = {s["speaker"] for s in doc["segments"] if s["source"] == "system"}
    assert sys_speakers == {f"{SPEAKER_LABEL_PREFIX} 1"}
    assert (mdir / "summary.json").exists()

    # The diarization JOB itself still terminated OK (state="done": "skipped" is
    # NOT a valid shared jobStateSchema value; the skip rides on the stage outcome).
    diar = _job_updates(events, JOB_KIND_DIARIZATION)
    assert diar[-1]["state"] == "done"


def test_diarizer_backend_crash_degrades_not_fatal(data_dir):
    """If a diarization backend RAISES (not just degrades), the pipeline still
    completes: diarization is skipped, the summary runs, no exception escapes."""

    class _BoomDiarizer:
        name = "boom"

        def diarize(self, wav_path, hf_token=None):
            raise RuntimeError("backend exploded")

    _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=_BoomDiarizer())

    done = _done(events)
    assert done["diarization"] == "skipped"
    assert done["summary"] == "done"


def test_native_diarizer_crash_degrades_meeting_still_finalizes(data_dir, monkeypatch, tmp_path):
    """CRASH-SAFETY INVARIANT (PRD-14): a NATIVE segfault in the sherpa-onnx
    backend (a C++ access violation no Python try/except can catch) must NEVER
    kill the sidecar. The real SherpaOnnxDiarizer isolates the ONNX run in a
    child process; here we force that child to hard-exit 139 (a real segfault's
    exit code) and assert run_postprocess STILL emits postProcessDone with
    diarization "skipped" + a degrade note, the summary still runs, and NOTHING
    propagates — the meeting finalizes.
    """
    from loqui_sidecar.postprocess import SherpaOnnxDiarizer, sherpa_models
    from loqui_sidecar.postprocess import sherpa_backend

    # Stage placeholder model files so the diarizer reaches the (crashing) child.
    models_dir = tmp_path / "diar_models"
    models_dir.mkdir()
    monkeypatch.setenv(sherpa_models.SHERPA_MODELS_DIR_ENV, str(models_dir))
    (models_dir / sherpa_models.SEGMENTATION_MODEL.filename).write_bytes(b"seg")
    (models_dir / sherpa_models.EMBEDDING_MODEL.filename).write_bytes(b"emb")

    _seed(data_dir, "m1", system_wav=True)

    # Replace the real child command with a genuine crashing one (os._exit(139)).
    real_run = sherpa_backend.subprocess.run

    def _run_crashing(cmd, **kwargs):
        return real_run([sys.executable, "-c", "import os; os._exit(139)"], **kwargs)

    monkeypatch.setattr(sherpa_backend.subprocess, "run", _run_crashing)

    events, emit = _collect_emit()
    # No exception must escape even though the child segfaults.
    run_postprocess(_request("m1"), emit, diarizer=SherpaOnnxDiarizer())

    done = _done(events)
    assert done["diarization"] == "skipped"  # degraded, not "done"
    assert done["summary"] == "done"  # the meeting still completes
    assert "diarization unavailable on this system" in done["note"]
    # A terminal postProcessDone WAS emitted (the meeting can finalize).
    assert any(e == POSTPROCESS_DONE_EVENT for e, _ in events)


# --- 3) SUMMARY-PROVIDER ERROR ------------------------------------------------


class _RaisingProvider:
    """A provider that yields a delta then raises — to assert a summary failure
    is reported but does not corrupt anything or block finalize."""

    name = "raiser"

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        yield "partial "
        raise ChatProviderError("provider_error", "summary provider blew up (no secrets)")


def test_summary_error_diarization_still_done_no_crash(data_dir, monkeypatch):
    """A summary-provider failure marks the summary stage "error" but diarization
    is still "done", the derived diarized file is intact, and postProcessDone is
    still emitted so main can finalize the meeting to "done". No crash."""
    # The summary selector must reach the raising provider (not the forced fake).
    monkeypatch.delenv(FAKE_CHAT_ENV, raising=False)
    mdir = _seed(data_dir, "m1")
    events, emit = _collect_emit()

    run_postprocess(
        _request("m1"),
        emit,
        diarizer=FakeDiarizer(),
        selector=lambda cfg: _RaisingProvider(),
    )

    done = _done(events)
    assert done["diarization"] == "done"  # diarization unaffected by summary failure
    assert done["summary"] == "error"

    # The summary error rode on a jobUpdate error; diarization done untouched.
    summary_jobs = _job_updates(events, JOB_KIND_SUMMARY)
    assert summary_jobs[-1]["state"] == "error"
    assert summary_jobs[-1]["error"]

    # Diarized transcript is intact; the (failed) summary did NOT write a file.
    assert (mdir / "transcript.diarized.json").exists()
    assert not (mdir / "summary.json").exists()


def test_summary_unexpected_crash_reported_not_fatal(data_dir, monkeypatch):
    """A non-ChatProviderError crash in the summary path is normalized to a
    summary "error" — it must not escape into app.py's worker."""
    monkeypatch.delenv(FAKE_CHAT_ENV, raising=False)
    _seed(data_dir, "m1")
    events, emit = _collect_emit()

    def boom(cfg):
        class _Boom:
            name = "boom"

            def stream_chat(self, *a, **k):
                raise RuntimeError("unexpected summary crash")

        return _Boom()

    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer(), selector=boom)
    done = _done(events)
    assert done["diarization"] == "done"
    assert done["summary"] == "error"


# --- regenerate-summary-only mode ---------------------------------------------


def test_regenerate_summary_skips_diarization(data_dir):
    """regenerate_summary=True runs ONLY the summary step (no diarization), so a
    user can refresh the summary without re-diarizing."""
    mdir = _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(_request("m1", regenerate_summary=True), emit, diarizer=FakeDiarizer())

    # No diarization JobUpdates at all; summary ran.
    assert _job_updates(events, JOB_KIND_DIARIZATION) == []
    assert _job_updates(events, JOB_KIND_SUMMARY)[-1]["state"] == "done"
    done = _done(events)
    assert done["diarization"] == "skipped"  # default stage when not run
    assert done["summary"] == "done"
    # No new diarized file written by a summary-only regen.
    assert not (mdir / "transcript.diarized.json").exists()
    assert (mdir / "summary.json").exists()


# --- idempotent re-diarization (PRD-5 AC#2) -----------------------------------


def test_rediarization_is_idempotent(data_dir):
    """Re-running diarization cleanly REPLACES the prior derived files with
    byte-identical output (align() is pure + the writers are atomic-replace)."""
    mdir = _seed(data_dir, "m1")
    _, emit1 = _collect_emit()
    run_postprocess(_request("m1"), emit1, diarizer=FakeDiarizer())
    first_json = (mdir / "transcript.diarized.json").read_bytes()
    first_md = (mdir / "transcript.diarized.md").read_bytes()

    _, emit2 = _collect_emit()
    run_postprocess(_request("m1"), emit2, diarizer=FakeDiarizer())
    assert (mdir / "transcript.diarized.json").read_bytes() == first_json
    assert (mdir / "transcript.diarized.md").read_bytes() == first_md


# --- empty / missing transcript -----------------------------------------------


def test_no_structured_transcript_still_completes(data_dir):
    """A meeting with no transcript.jsonl yet (no confirmed segments) still
    completes: empty diarized segments, summary runs, postProcessDone emitted."""
    mdir = data_dir / "meetings" / "m1"
    mdir.mkdir(parents=True)
    (mdir / "transcript.live.md").write_text("", encoding="utf-8")  # nothing confirmed
    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer())

    done = _done(events)
    assert done["speakers"] == []  # no system segments -> no speakers
    doc = json.loads((mdir / "transcript.diarized.json").read_text(encoding="utf-8"))
    assert doc["segments"] == []
    # Summary stage still ran (the fake provider yields text even with no context).
    assert done["summary"] == "done"


# --- secrets never leak (cross-cutting) ---------------------------------------


def test_secrets_never_leak_into_emitted_events(data_dir):
    """The transient BYOK api_key + HF token are never echoed into any emitted
    notification or written into the derived files."""
    mdir = _seed(data_dir, "m1", system_wav=True)
    events, emit = _collect_emit()
    api_secret = "sk-ant-SUPER-SECRET-SUMMARY-KEY"
    hf_secret = "hf_SUPER_SECRET_TOKEN"
    req = _request("m1", api_key=api_secret, hf_token=hf_secret)
    # Use the real PyannoteDiarizer so the hf_token flows through the (degrading)
    # diarization path; its note must NOT contain the token.
    run_postprocess(req, emit, diarizer=PyannoteDiarizer())

    blob = repr(events)
    assert api_secret not in blob
    assert hf_secret not in blob
    for fname in ("transcript.diarized.json", "transcript.diarized.md", "summary.json"):
        p = mdir / fname
        if p.exists():
            text = p.read_text(encoding="utf-8")
            assert api_secret not in text
            assert hf_secret not in text


# --- THE HEADLINE: the AI never edits the transcript --------------------------


def test_live_and_jsonl_byte_identical_after_full_run(data_dir):
    """CROSS-CUTTING INVARIANT (behavioral): a full diarize+summary run leaves
    transcript.live.md AND transcript.jsonl byte-for-byte unchanged. The diarized
    + summary outputs are SEPARATE derived files."""
    mdir = _seed(data_dir, "m1")
    live = mdir / "transcript.live.md"
    jsonl = mdir / "transcript.jsonl"
    live_before = live.read_bytes()
    jsonl_before = jsonl.read_bytes()

    events, emit = _collect_emit()
    run_postprocess(_request("m1"), emit, diarizer=FakeDiarizer())

    assert _done(events)["summary"] == "done"  # the run actually happened
    assert live.read_bytes() == live_before
    assert jsonl.read_bytes() == jsonl_before
    # The derived files are SEPARATE (not the live transcript).
    assert (mdir / "transcript.diarized.json").exists()
    assert (mdir / "summary.json").exists()


def test_live_and_jsonl_untouched_on_summary_error(data_dir, monkeypatch):
    """Even when the summary provider raises mid-stream, the transcript files are
    untouched (the failure must not corrupt anything)."""
    monkeypatch.delenv(FAKE_CHAT_ENV, raising=False)
    mdir = _seed(data_dir, "m1")
    live_before = (mdir / "transcript.live.md").read_bytes()
    jsonl_before = (mdir / "transcript.jsonl").read_bytes()

    events, emit = _collect_emit()
    run_postprocess(
        _request("m1"),
        emit,
        diarizer=FakeDiarizer(),
        selector=lambda cfg: _RaisingProvider(),
    )
    assert _done(events)["summary"] == "error"
    assert (mdir / "transcript.live.md").read_bytes() == live_before
    assert (mdir / "transcript.jsonl").read_bytes() == jsonl_before


def test_run_postprocess_never_raises_on_garbage_request(data_dir):
    """The coordinator never raises into app.py's worker — even a request for a
    nonexistent meeting completes with a terminal postProcessDone."""
    events, emit = _collect_emit()
    # No meeting seeded at all.
    run_postprocess(_request("ghost"), emit, diarizer=FakeDiarizer())
    done = _done(events)  # still terminates
    assert done["meetingId"] == "ghost"


# --- structured summary parsing (PRD-5 summaries: tldr/decisions/action_items/topics) ---


def test_parse_summary_structured_json():
    """A clean JSON envelope maps onto all structured Summary fields."""
    from loqui_sidecar.postprocess.summary import _parse_summary

    text = json.dumps(
        {
            "tldr": "We shipped the diarization pipeline.",
            "decisions": ["Ship PRD-5", "Defer real-name mapping to PRD-6"],
            "action_items": [
                {"text": "Write the opt-in test", "owner": "Joaquin"},
                {"text": "Update CI", "owner": None},
                "Bare string item",
            ],
            "topics": ["diarization", "summaries"],
        }
    )
    s = _parse_summary(text, meeting_id="m1", provider="fake", model="fake")
    assert s.tldr == "We shipped the diarization pipeline."
    assert s.decisions == ["Ship PRD-5", "Defer real-name mapping to PRD-6"]
    assert [(a.text, a.owner) for a in s.action_items] == [
        ("Write the opt-in test", "Joaquin"),
        ("Update CI", None),
        ("Bare string item", None),
    ]
    assert s.topics == ["diarization", "summaries"]
    assert s.provider == "fake" and s.model == "fake" and s.meeting_id == "m1"


def test_parse_summary_json_in_code_fence_and_prose():
    """A fenced / prose-wrapped JSON object is still extracted."""
    from loqui_sidecar.postprocess.summary import _parse_summary

    text = 'Here you go:\n```json\n{"tldr": "Done.", "decisions": [], "action_items": [], "topics": ["x"]}\n```'
    s = _parse_summary(text, meeting_id="m1", provider="anthropic", model="claude")
    assert s.tldr == "Done."
    assert s.topics == ["x"]


def test_parse_summary_markdown_title_and_overview():
    """The default notetaker output is a markdown document: the leading `# Title`
    becomes `title` and the rest becomes the markdown `overview`."""
    from loqui_sidecar.postprocess.summary import _parse_summary

    text = "# Sarah and John Plan Q2 Budget\n\n## Budget\n- Finalized at $1.2M.\n\n## Next steps\n- Sarah sends the deck."
    s = _parse_summary(text, meeting_id="m1", provider="anthropic", model="claude")
    assert s.title == "Sarah and John Plan Q2 Budget"
    assert "## Budget" in s.overview and "Finalized at $1.2M." in s.overview
    # The leading `# Title` line is stripped out of the overview body (but the
    # `##` section headers remain — they're part of the document).
    assert "# Sarah and John Plan Q2 Budget" not in s.overview
    assert s.overview.startswith("## Budget")
    # Legacy structured fields stay empty for the markdown path.
    assert s.tldr == "" and s.decisions == [] and s.action_items == [] and s.topics == []


def test_parse_summary_falls_back_to_overview_when_no_title():
    """Non-JSON prose with no leading `# Title` keeps an empty title and puts the
    whole text in `overview` so the summary stays non-empty + searchable."""
    from loqui_sidecar.postprocess.summary import _parse_summary

    text = "[fake] context reply to: Summarize the meeting"
    s = _parse_summary(text, meeting_id="m1", provider="fake", model="fake")
    assert s.title == ""
    assert s.overview == text
    assert s.tldr == "" and s.decisions == [] and s.action_items == [] and s.topics == []


def test_full_run_summary_structured_fields_searchable_in_index(data_dir):
    """When the provider returns structured JSON, decisions/action_items/topics
    are folded into postProcessDone.indexText (mirrors main-side buildIndexText)."""

    class _JsonProvider:
        name = "fake"

        def stream_chat(self, messages, config, api_key=None):
            yield json.dumps(
                {
                    "tldr": "TLDR_MARKER",
                    "decisions": ["DECISION_MARKER"],
                    "action_items": [{"text": "ACTION_MARKER", "owner": "OWNER_MARKER"}],
                    "topics": ["TOPIC_MARKER"],
                }
            )

    mdir = _seed(data_dir, "m1")
    events, emit = _collect_emit()
    run_postprocess(
        _request("m1"),
        emit,
        diarizer=FakeDiarizer(),
        selector=lambda cfg: _JsonProvider(),
    )

    summary = json.loads((mdir / "summary.json").read_text(encoding="utf-8"))
    assert summary["tldr"] == "TLDR_MARKER"
    assert summary["decisions"] == ["DECISION_MARKER"]
    assert summary["actionItems"] == [{"text": "ACTION_MARKER", "owner": "OWNER_MARKER"}]
    assert summary["topics"] == ["TOPIC_MARKER"]

    index_text = _done(events)["indexText"]
    for marker in (
        "TLDR_MARKER",
        "DECISION_MARKER",
        "ACTION_MARKER",
        "OWNER_MARKER",
        "TOPIC_MARKER",
    ):
        assert marker in index_text
