"""Hermetic unit tests for the per-(meeting,source) transcription pipeline +
the manager running TWO independent pipelines (PRD-2 "pipeline-orchestration").

NO model, NO network, NO devices, NO real ``~/Loqui``: every test drives the
pipeline with the deterministic FAKE :class:`AsrBackend` (scripted tokens) and
synthetic PCM. faster-whisper is never imported here. Fast + deterministic.

What is asserted (per the build-unit charter):

* a growing hypothesis produces ``partial`` segments that update in place under
  ONE stable ``seg_id``, then a single ``final`` committing that ``seg_id``;
* segments carry the correct ``source`` and meeting-relative ``t_start``/``t_end``;
* finals are monotonic with NO duplicate / overlapping ``seg_id``;
* two pipelines (mic + system) run concurrently and stay independent — no shared
  buffer / policy state, no cross-talk;
* ``finish`` (audioStop) flushes a trailing ``final``;
* the LocalAgreement-2 policy commits each token at most once and never retracts;
* the energy VAD endpoints on trailing silence;
* the backpressure path keeps the live buffer bounded under a flood of frames.
"""

from __future__ import annotations

import struct
import threading

import pytest

from loqui_sidecar.audio_ingest import AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_WIDTH_BYTES, DecodedFrame
from loqui_sidecar.transcription import (
    AsrToken,
    FakeAsrBackend,
    PolicyResult,
    StreamingPolicy,
    TranscriptionManager,
    TranscriptSegment,
)
from loqui_sidecar.transcription.pipeline import (
    EnergyVad,
    LocalAgreementPolicy,
    PipelineConfig,
    StreamingTranscriptionPipeline,
    VadEndpointer,
    make_pipeline_factory,
)

# --- synthetic PCM helpers ----------------------------------------------------

_MS = 250  # default frame duration; long enough to trip the decode window.


def _samples(ms: int) -> int:
    return int(AUDIO_SAMPLE_RATE * ms / 1000)


def speech_pcm(amp: int = 9000, ms: int = _MS) -> bytes:
    """A loud constant-amplitude chunk the energy VAD reads as speech."""
    n = _samples(ms)
    return struct.pack(f"<{n}h", *([amp] * n))


def silence_pcm(ms: int = _MS) -> bytes:
    return b"\x00" * (_samples(ms) * AUDIO_SAMPLE_WIDTH_BYTES)


def frame(source: str, seq: int, pcm: bytes) -> DecodedFrame:
    # captureTimestampMs advances by the frame duration so the pipeline can place
    # segments on the meeting timeline.
    ms_per = (len(pcm) // AUDIO_SAMPLE_WIDTH_BYTES) / AUDIO_SAMPLE_RATE * 1000.0
    return DecodedFrame(source=source, seq=seq, timestamp_ms=seq * ms_per, pcm=pcm)


def growing_script(words_per_decode: list[list[str]]):
    """A FakeAsrBackend script: decode N returns ``words_per_decode[N]`` (clamped
    to the last entry), each word a 0.4s token, in time order. Models a
    stabilizing hypothesis so LocalAgreement-2 has a prefix to agree on."""

    def script(decode_index: int, _pcm_bytes: int) -> list[AsrToken]:
        words = words_per_decode[min(decode_index, len(words_per_decode) - 1)]
        out: list[AsrToken] = []
        t = 0.0
        for w in words:
            out.append(AsrToken(text=w, t_start=t, t_end=t + 0.4))
            t += 0.4
        return out

    return script


def fast_decode_config(**over) -> PipelineConfig:
    """Small windows so a handful of test frames exercise decodes + endpoints."""
    base = dict(decode_interval_seconds=0.2, min_decode_seconds=0.2)
    base.update(over)
    return PipelineConfig(**base)


def feed_utterance(
    pipe: StreamingTranscriptionPipeline,
    source: str,
    *,
    start_seq: int = 0,
    speech_frames: int = 4,
    trailing_silence: int = 4,
) -> int:
    """Feed a speech burst then trailing silence (to trip the VAD endpoint).
    Returns the next sequence number."""
    seq = start_seq
    for _ in range(speech_frames):
        pipe.feed(frame(source, seq, speech_pcm()))
        seq += 1
    for _ in range(trailing_silence):
        pipe.feed(frame(source, seq, silence_pcm()))
        seq += 1
    return seq


# --- LocalAgreement-2 policy --------------------------------------------------


def _toks(words: list[str], step: float = 0.5) -> list[AsrToken]:
    out: list[AsrToken] = []
    t = 0.0
    for w in words:
        out.append(AsrToken(text=w, t_start=t, t_end=t + step))
        t += step
    return out


def test_local_agreement_policy_satisfies_protocol():
    assert isinstance(LocalAgreementPolicy(), StreamingPolicy)


def test_local_agreement_commits_agreed_prefix_only():
    p = LocalAgreementPolicy()
    # First decode: nothing to agree with yet -> all partial, nothing committed.
    r1 = p.update(_toks(["the", "quick"]))
    assert r1.committed == []
    assert [t.text for t in r1.partial] == ["the", "quick"]

    # Second decode agrees on "the quick" -> those commit; "brown" stays partial.
    r2 = p.update(_toks(["the", "quick", "brown"]))
    assert [t.text for t in r2.committed] == ["the", "quick"]
    assert [t.text for t in r2.partial] == ["brown"]
    assert r2.committed_seconds == pytest.approx(1.0)


def test_local_agreement_never_recommits_and_is_monotonic():
    p = LocalAgreementPolicy()
    p.update(_toks(["a", "b"]))
    r2 = p.update(_toks(["a", "b", "c"]))
    assert [t.text for t in r2.committed] == ["a", "b"]
    r3 = p.update(_toks(["a", "b", "c", "d"]))
    # "c" agreed across decode 2+3 -> commits exactly once now (not "a"/"b" again).
    assert [t.text for t in r3.committed] == ["c"]
    assert r3.committed_seconds >= r2.committed_seconds  # non-decreasing
    # flush commits the trailing un-agreed tail once; re-flush is a no-op.
    f1 = p.flush()
    assert [t.text for t in f1.committed] == ["d"]
    assert p.flush().committed == []


def test_local_agreement_reset_clears_state():
    p = LocalAgreementPolicy()
    p.update(_toks(["x"]))
    p.update(_toks(["x"]))
    p.reset()
    r = p.update(_toks(["y"]))
    assert r.committed == [] and [t.text for t in r.partial] == ["y"]


# --- energy VAD endpointer ----------------------------------------------------


def test_energy_vad_detects_speech_and_endpoints_on_trailing_silence():
    v = EnergyVad(hangover_seconds=0.3)
    assert isinstance(v, VadEndpointer)
    assert v.accept(silence_pcm(100)) == (False, False)  # leading silence
    assert v.accept(speech_pcm(ms=100)) == (True, False)  # speech
    assert v.accept(silence_pcm(100)) == (False, False)  # 0.1s silence
    assert v.accept(silence_pcm(100)) == (False, False)  # 0.2s
    assert v.accept(silence_pcm(100)) == (False, True)  # 0.3s -> endpoint


def test_energy_vad_reset_rearms():
    v = EnergyVad(hangover_seconds=0.2)
    v.accept(speech_pcm(ms=100))
    v.reset()
    # After reset, pure silence cannot endpoint (no speech has been seen).
    assert v.accept(silence_pcm(300)) == (False, False)


# --- pipeline: partial -> final, ids, timestamps, source ----------------------


def test_pipeline_emits_partials_then_one_final_with_stable_seg_id():
    backend = FakeAsrBackend(
        script=growing_script([["hello"], ["hello", "world"], ["hello", "world"]])
    )
    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, backend, config=fast_decode_config()
    )
    feed_utterance(pipe, "mic")
    pipe.finish()

    partials = [s for s in emitted if s.status == "partial"]
    finals = [s for s in emitted if s.status == "final"]

    assert partials, "expected interim partials"
    assert len(finals) == 1, "exactly one final per utterance"
    # All segments for the utterance share ONE seg id (partial superseded by final).
    seg_ids = {s.seg_id for s in emitted}
    assert len(seg_ids) == 1
    assert finals[0].seg_id in {s.seg_id for s in partials}
    # Final text is the committed hypothesis; non-empty seg id.
    assert finals[0].text == "hello world"
    assert finals[0].seg_id != ""
    # Every segment is tagged the correct source.
    assert all(s.source == "mic" for s in emitted)


def test_pipeline_segment_timestamps_are_meeting_relative_and_ordered():
    backend = FakeAsrBackend(script=growing_script([["a"], ["a", "b"], ["a", "b"]]))
    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, backend, config=fast_decode_config()
    )
    # Two leading silence frames (dropped), then speech from seq=2 (=> 0.5s).
    seq = 0
    for _ in range(2):
        pipe.feed(frame("mic", seq, silence_pcm()))
        seq += 1
    feed_utterance(pipe, "mic", start_seq=seq)
    pipe.finish()

    for s in emitted:
        assert s.t_end >= s.t_start
        assert s.t_start >= 0.0
    final = next(s for s in emitted if s.status == "final")
    # Utterance starts at the first SPEECH frame (~0.5s in), not at t=0 — leading
    # silence was dropped.
    assert final.t_start == pytest.approx(0.5, abs=0.01)


def test_pipeline_multiple_utterances_have_distinct_non_overlapping_seg_ids():
    # Two speech bursts separated by enough silence to endpoint between them.
    backend = FakeAsrBackend(script=growing_script([["one"], ["one", "two"], ["one", "two"]]))
    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, backend, config=fast_decode_config()
    )
    seq = feed_utterance(pipe, "mic", start_seq=0)
    feed_utterance(pipe, "mic", start_seq=seq)
    pipe.finish()

    finals = [s for s in emitted if s.status == "final"]
    assert len(finals) == 2, "one final per utterance"
    ids = [s.seg_id for s in finals]
    assert len(set(ids)) == len(ids), "no duplicate final seg ids across utterances"


def test_pipeline_silence_only_emits_nothing_and_never_decodes():
    backend = FakeAsrBackend(script=growing_script([["ghost"]]))
    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, backend, config=fast_decode_config()
    )
    for seq in range(8):
        pipe.feed(frame("mic", seq, silence_pcm()))
    pipe.finish()
    # Pure silence never reaches the backend; nothing is emitted.
    assert emitted == []
    assert backend.decode_count == 0


def test_pipeline_finish_flushes_trailing_final_without_endpoint():
    # Speech with NO trailing silence: the VAD never endpoints, so only finish()
    # (audioStop) can produce the final.
    backend = FakeAsrBackend(
        script=growing_script([["keep"], ["keep", "going"], ["keep", "going"]])
    )
    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, backend, config=fast_decode_config()
    )
    for seq in range(5):
        pipe.feed(frame("mic", seq, speech_pcm()))
    assert not any(s.status == "final" for s in emitted), "no final before finish()"
    pipe.finish()
    finals = [s for s in emitted if s.status == "final"]
    assert len(finals) == 1
    assert finals[0].text == "keep going"


def test_pipeline_handles_leading_insertion_without_duplicating_committed_word():
    """ADVERSARIAL (regression for the live-path policy): the real faster-whisper
    backend routinely shifts token indices between decodes of a growing window —
    e.g. it inserts a leading word ("um") it had not produced before. A policy
    that tracks an absolute committed-token *index* (instead of re-aligning to the
    committed *text*) would re-emit an already-committed word, producing a
    duplicate like "i think think so". The live path uses the robust
    ``streaming.LocalAgreementPolicy`` (strips the committed prefix by matching
    text in order), so the final must NOT contain a duplicated committed word.

    The FAKE backend's clean growing prefixes never trigger this, so without this
    test the gate would not exercise hypothesis revision. We script the index
    shift explicitly.
    """

    def insertion_script(decode_index: int, _n: int) -> list[AsrToken]:
        # decode 0 + 1 agree on "i think" -> committed. decode 2+ INSERT a leading
        # "um" (index shift) and extend with "so": a weak index-based policy would
        # re-commit "think"; the robust text-aligned policy must not.
        scripts = [
            ["i", "think"],
            ["i", "think"],
            ["um", "i", "think", "so"],
            ["um", "i", "think", "so"],
        ]
        words = scripts[min(decode_index, len(scripts) - 1)]
        out: list[AsrToken] = []
        t = 0.0
        for w in words:
            out.append(AsrToken(text=w, t_start=t, t_end=t + 0.4))
            t += 0.4
        return out

    backend = FakeAsrBackend(script=insertion_script)
    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, backend, config=fast_decode_config()
    )
    feed_utterance(pipe, "mic", speech_frames=6, trailing_silence=4)
    pipe.finish()

    finals = [s for s in emitted if s.status == "final"]
    assert len(finals) == 1
    words = finals[0].text.split()
    # No word is committed twice in a row (the duplicate the weak policy produced).
    assert all(a != b for a, b in zip(words, words[1:])), f"duplicate word in {words!r}"
    assert "think" in words and words.count("think") == 1
    # And every partial is equally free of the duplicate.
    for s in (s for s in emitted if s.status == "partial"):
        pw = s.text.split()
        assert all(a != b for a, b in zip(pw, pw[1:])), f"duplicate in partial {pw!r}"


def test_pipeline_feed_and_finish_never_raise_on_backend_error():
    class BoomBackend:
        name = "boom"
        is_loaded = True

        def load(self):  # pragma: no cover - is_loaded already True
            pass

        def transcribe(self, pcm, sample_rate=AUDIO_SAMPLE_RATE, language=None):
            raise RuntimeError("decode boom")

    emitted: list[TranscriptSegment] = []
    pipe = StreamingTranscriptionPipeline(
        "m1", "mic", emitted.append, BoomBackend(), config=fast_decode_config()
    )
    feed_utterance(pipe, "mic")  # must not raise despite every decode throwing
    pipe.finish()
    assert emitted == []  # a failing decode degrades to a logged drop


# --- backpressure: bounded buffer ---------------------------------------------


def test_pipeline_buffer_is_bounded_under_a_flood_of_frames():
    # A backend that never produces an agreeing prefix => the policy commits
    # nothing and the utterance never naturally ends; only the max-utterance cap
    # can keep the buffer bounded. Feed far more than the cap's worth of speech.
    def never_agree(decode_index: int, _n: int) -> list[AsrToken]:
        # Distinct text each decode -> LocalAgreement never finds a stable prefix.
        return [AsrToken(text=f"w{decode_index}", t_start=0.0, t_end=0.4)]

    backend = FakeAsrBackend(script=never_agree)
    emitted: list[TranscriptSegment] = []
    cap = 1.0  # 1s utterance cap
    cfg = fast_decode_config(max_utterance_seconds=cap)
    pipe = StreamingTranscriptionPipeline("m1", "mic", emitted.append, backend, config=cfg)

    max_buffered = 0.0
    for seq in range(200):  # ~50s of speech at 0.25s/frame, dwarfing the 1s cap
        pipe.feed(frame("mic", seq, speech_pcm()))
        max_buffered = max(max_buffered, pipe._buffered_seconds())
    # The live buffer never grows past the cap (+ one frame's worth of slack).
    assert max_buffered <= cap + (_MS / 1000.0) + 1e-6
    pipe.finish()


def test_pipeline_decode_is_windowed_not_per_frame():
    # decode_interval_seconds gates how often the backend runs, so a flood of
    # tiny frames does not queue a decode per frame (bounded ASR work).
    backend = FakeAsrBackend(script=growing_script([["x"]]))
    emitted: list[TranscriptSegment] = []
    # 1.0s decode window; 0.25s frames => one decode per ~4 frames.
    cfg = PipelineConfig(decode_interval_seconds=1.0, min_decode_seconds=0.2)
    pipe = StreamingTranscriptionPipeline("m1", "mic", emitted.append, backend, config=cfg)
    for seq in range(8):  # 2.0s of speech
        pipe.feed(frame("mic", seq, speech_pcm()))
    # Far fewer decodes than frames fed.
    assert backend.decode_count <= 3
    assert backend.decode_count < 8


# --- two INDEPENDENT pipelines (mic + system) ---------------------------------


def test_two_pipelines_run_independently_no_cross_talk():
    mic_backend = FakeAsrBackend(
        script=growing_script([["you"], ["you", "speak"], ["you", "speak"]])
    )
    sys_backend = FakeAsrBackend(
        script=growing_script([["they"], ["they", "reply"], ["they", "reply"]])
    )
    mic_out: list[TranscriptSegment] = []
    sys_out: list[TranscriptSegment] = []
    mic = StreamingTranscriptionPipeline(
        "m1", "mic", mic_out.append, mic_backend, config=fast_decode_config()
    )
    sysp = StreamingTranscriptionPipeline(
        "m1", "system", sys_out.append, sys_backend, config=fast_decode_config()
    )

    # Interleave frames across the two pipelines (as the manager would).
    seq = 0
    for _ in range(4):
        mic.feed(frame("mic", seq, speech_pcm()))
        sysp.feed(frame("system", seq, speech_pcm()))
        seq += 1
    for _ in range(4):
        mic.feed(frame("mic", seq, silence_pcm()))
        sysp.feed(frame("system", seq, silence_pcm()))
        seq += 1
    mic.finish()
    sysp.finish()

    assert all(s.source == "mic" for s in mic_out)
    assert all(s.source == "system" for s in sys_out)
    mic_final = next(s for s in mic_out if s.status == "final")
    sys_final = next(s for s in sys_out if s.status == "final")
    assert mic_final.text == "you speak"
    assert sys_final.text == "they reply"
    # No cross-talk: seg ids are namespaced by source and never collide.
    assert mic_final.seg_id != sys_final.seg_id
    assert "mic" in mic_final.seg_id and "system" in sys_final.seg_id


# --- manager + real pipeline factory (two pipelines via the FrameConsumer) -----


def test_manager_runs_two_real_pipelines_independently():
    # Each (meeting, source) gets its OWN backend instance via the factory, so
    # mic and system never share decode state.
    def per_source_backend(source: str) -> FakeAsrBackend:
        if source == "mic":
            return FakeAsrBackend(script=growing_script([["a"], ["a", "b"], ["a", "b"]]))
        return FakeAsrBackend(script=growing_script([["c"], ["c", "d"], ["c", "d"]]))

    base_factory = make_pipeline_factory(fast_decode_config())

    def factory(meeting_id, source, emit, backend, config):
        # Swap in a per-source scripted backend (ignore the manager's shared one).
        return base_factory(meeting_id, source, emit, per_source_backend(source), config)

    emitted: list[TranscriptSegment] = []
    mgr = TranscriptionManager(emit=emitted.append, pipeline_factory=factory)

    mgr.on_start("m1", "mic")
    mgr.on_start("m1", "system")
    seq = 0
    for _ in range(4):
        mgr.on_frame("m1", "mic", frame("mic", seq, speech_pcm()))
        mgr.on_frame("m1", "system", frame("system", seq, speech_pcm()))
        seq += 1
    for _ in range(4):
        mgr.on_frame("m1", "mic", frame("mic", seq, silence_pcm()))
        mgr.on_frame("m1", "system", frame("system", seq, silence_pcm()))
        seq += 1
    mgr.on_stop("m1", "mic")
    mgr.on_stop("m1", "system")

    finals = [s for s in emitted if s.status == "final"]
    by_source = {s.source: s for s in finals}
    assert set(by_source) == {"mic", "system"}
    assert by_source["mic"].text == "a b"
    assert by_source["system"].text == "c d"
    # Independent: each source's seg id carries only its own source tag.
    assert "mic" in by_source["mic"].seg_id and "system" not in by_source["mic"].seg_id
    assert (
        "system" in by_source["system"].seg_id
        and by_source["system"].seg_id != by_source["mic"].seg_id
    )


def test_manager_concurrent_feeds_stay_independent_under_threads():
    # Drive mic + system from two threads at once: the manager's lock + per-source
    # pipelines must keep the two streams from corrupting each other.
    factory = make_pipeline_factory(fast_decode_config())
    backend = FakeAsrBackend(script=growing_script([["x"], ["x", "y"], ["x", "y"]]))
    emitted: list[TranscriptSegment] = []
    lock = threading.Lock()

    def safe_emit(seg: TranscriptSegment) -> None:
        with lock:
            emitted.append(seg)

    mgr = TranscriptionManager(emit=safe_emit, backend=backend, pipeline_factory=factory)
    mgr.on_start("m1", "mic")
    mgr.on_start("m1", "system")

    def pump(source: str) -> None:
        seq = 0
        for _ in range(4):
            mgr.on_frame("m1", source, frame(source, seq, speech_pcm()))
            seq += 1
        for _ in range(4):
            mgr.on_frame("m1", source, frame(source, seq, silence_pcm()))
            seq += 1

    t_mic = threading.Thread(target=pump, args=("mic",))
    t_sys = threading.Thread(target=pump, args=("system",))
    t_mic.start()
    t_sys.start()
    t_mic.join()
    t_sys.join()
    mgr.on_stop("m1", "mic")
    mgr.on_stop("m1", "system")

    finals = [s for s in emitted if s.status == "final"]
    sources = {s.source for s in finals}
    assert sources == {"mic", "system"}
    # Each emitted segment is internally consistent (source matches its seg id).
    for s in emitted:
        assert s.source in s.seg_id
    # No duplicate final seg ids.
    final_ids = [s.seg_id for s in finals]
    assert len(set(final_ids)) == len(final_ids)


def test_manager_factory_passes_language_from_transcription_config():
    captured: dict = {}

    def factory(meeting_id, source, emit, backend, config):
        real = make_pipeline_factory(fast_decode_config())(
            meeting_id, source, emit, backend, config
        )
        captured["language"] = real._language
        return real

    from loqui_sidecar.transcription import TranscriptionConfig

    mgr = TranscriptionManager(pipeline_factory=factory, config=TranscriptionConfig(language="es"))
    mgr.on_start("m1", "mic")
    assert captured["language"] == "es"
    mgr.on_stop("m1", "mic")


def test_policy_result_used_by_pipeline_defaults():
    # Guard the contract the pipeline relies on (empty defaults).
    r = PolicyResult()
    assert r.committed == [] and r.partial == [] and r.committed_seconds == 0.0
