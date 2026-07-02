"""PRD-2 Foundation tests: the transcription contract seams.

Hermetic + fast: uses the deterministic FAKE AsrBackend (no model download, no
inference, no network) and exercises the FrameConsumer wiring + the WS-emitter
adapter. Does NOT import faster-whisper. The real-model smoke is separate +
opt-in.
"""

from __future__ import annotations


from loqui_sidecar.audio_ingest import AudioIngest, DecodedFrame
from loqui_sidecar.transcription import (
    TRANSCRIPT_SEGMENT_EVENT,
    AsrBackend,
    AsrToken,
    FakeAsrBackend,
    PolicyResult,
    StreamingPolicy,
    TranscriptionManager,
    TranscriptSegment,
    default_transcription_manager,
)
from loqui_sidecar.transcription.manager import make_ws_emitter


def _frame(source: str, seq: int = 0) -> DecodedFrame:
    # 320 samples of silence @ 16 kHz mono pcm_s16le = 640 bytes (the 20 ms default).
    return DecodedFrame(source=source, seq=seq, timestamp_ms=seq * 20.0, pcm=b"\x00" * 640)


def test_fake_backend_satisfies_protocol_and_is_scriptable():
    tok = AsrToken(text="hello", t_start=0.0, t_end=0.5)
    backend = FakeAsrBackend(script=lambda i, n: [tok] if i == 0 else [])
    assert isinstance(backend, AsrBackend)
    assert backend.is_loaded is False
    backend.load()
    assert backend.is_loaded is True
    assert backend.transcribe(b"\x00" * 640) == [tok]
    assert backend.transcribe(b"\x00" * 640) == []
    assert backend.decode_count == 2


def test_transcript_segment_to_wire_matches_ts_camelcase_keys():
    seg = TranscriptSegment(
        meeting_id="m-1",
        source="mic",
        text="hi there",
        t_start=1.5,
        t_end=2.0,
        status="final",
        seg_id="seg-1",
    )
    assert seg.to_wire() == {
        "meetingId": "m-1",
        "source": "mic",
        "text": "hi there",
        "tStart": 1.5,
        "tEnd": 2.0,
        "status": "final",
        "segId": "seg-1",
    }


def test_make_ws_emitter_sends_one_transcript_notification():
    sent: list[tuple[str, dict]] = []
    emitter = make_ws_emitter(lambda event, data: sent.append((event, data)))
    emitter(
        TranscriptSegment(
            meeting_id="m-1",
            source="system",
            text="ok",
            t_start=0.0,
            t_end=0.3,
            status="partial",
            seg_id="seg-9",
        )
    )
    assert len(sent) == 1
    event, data = sent[0]
    assert event == TRANSCRIPT_SEGMENT_EVENT == "transcriptSegment"
    assert data["source"] == "system"
    assert data["segId"] == "seg-9"


def test_manager_is_frame_consumer_and_default_pipeline_emits_nothing():
    emitted: list[TranscriptSegment] = []
    mgr = TranscriptionManager(emit=emitted.append)
    # Drive the FrameConsumer lifecycle for both sources independently.
    mgr.on_start("m-1", "mic")
    mgr.on_start("m-1", "system")
    for i in range(3):
        mgr.on_frame("m-1", "mic", _frame("mic", i))
        mgr.on_frame("m-1", "system", _frame("system", i))
    mgr.on_stop("m-1", "mic")
    mgr.on_stop("m-1", "system")
    # Foundation default pipeline is a no-op: PRD-1 untouched, zero segments.
    assert mgr.frames_seen == 6
    assert emitted == []


def test_manager_routes_to_independent_per_source_pipelines():
    # A factory whose pipeline emits a final segment per frame, tagging source,
    # proves frames route to the correct (meeting, source) pipeline.
    def factory(meeting_id, source, emit, backend, config):
        class P:
            def feed(self, frame):
                emit(
                    TranscriptSegment(
                        meeting_id=meeting_id,
                        source=source,
                        text=f"{source}-{frame.seq}",
                        t_start=0.0,
                        t_end=0.1,
                        status="final",
                        seg_id=f"{source}-{frame.seq}",
                    )
                )

            def finish(self):
                pass

        return P()

    emitted: list[TranscriptSegment] = []
    mgr = TranscriptionManager(emit=emitted.append, pipeline_factory=factory)
    mgr.on_start("m-1", "mic")
    mgr.on_start("m-1", "system")
    mgr.on_frame("m-1", "mic", _frame("mic", 0))
    mgr.on_frame("m-1", "system", _frame("system", 0))
    mgr.on_stop("m-1", "mic")
    mgr.on_stop("m-1", "system")

    assert {s.source for s in emitted} == {"mic", "system"}
    assert all(s.source in s.seg_id for s in emitted)  # no cross-wiring
    assert mgr.segments_emitted == 2


def test_manager_frame_before_start_is_dropped_not_raised():
    emitted: list[TranscriptSegment] = []
    mgr = TranscriptionManager(emit=emitted.append)
    # No on_start: must be a silent drop, never an exception.
    mgr.on_frame("m-1", "mic", _frame("mic", 0))
    assert emitted == []


def test_manager_guards_emitter_and_pipeline_errors():
    def factory(meeting_id, source, emit, backend, config):
        class P:
            def feed(self, frame):
                emit(
                    TranscriptSegment(
                        meeting_id=meeting_id,
                        source=source,
                        text="x",
                        t_start=0.0,
                        t_end=0.1,
                        status="partial",
                        seg_id="s",
                    )
                )

            def finish(self):
                raise RuntimeError("finish boom")

        return P()

    def boom_emit(_segment):
        raise RuntimeError("emit boom")

    mgr = TranscriptionManager(emit=boom_emit, pipeline_factory=factory)
    # None of these should raise despite the emitter + finish raising.
    mgr.on_start("m-1", "mic")
    mgr.on_frame("m-1", "mic", _frame("mic", 0))
    mgr.on_stop("m-1", "mic")
    mgr.close()


def test_manager_subscribes_to_audio_ingest_as_consumer():
    # The PRD-1 hook: AudioIngest.add_consumer(manager) must deliver decoded
    # frames to the manager alongside the WAV writer.
    seen: list[tuple[str, str]] = []

    def factory(meeting_id, source, emit, backend, config):
        class P:
            def feed(self, frame):
                seen.append((meeting_id, source))

            def finish(self):
                pass

        return P()

    mgr = TranscriptionManager(pipeline_factory=factory)
    ingest = AudioIngest(consumers=[mgr])
    ingest.handle_audio_start("m-1", "mic")
    # Build one real binary frame (header + pcm) so it routes by source byte.
    from loqui_sidecar.audio_ingest import AUDIO_FRAME_HEADER_BYTES
    import struct

    header = bytearray(AUDIO_FRAME_HEADER_BYTES)
    header[0] = 0xA0  # magic
    header[1] = 0  # mic
    struct.pack_into("<I", header, 4, 0)  # seq
    struct.pack_into("<d", header, 8, 0.0)  # ts
    ingest.handle_binary_frame(bytes(header) + b"\x00" * 640)
    ingest.handle_audio_stop("m-1", "mic")
    assert seen == [("m-1", "mic")]


def test_policy_result_defaults():
    r = PolicyResult()
    assert r.committed == [] and r.partial == [] and r.committed_seconds == 0.0


def test_default_manager_uses_fake_backend_under_env_and_real_pipeline():
    # Under LOQUI_FAKE_ASR=1 (set by conftest for the whole gate) the live
    # default manager wires the FAKE backend + the REAL streaming pipeline — no
    # model download, but the actual LocalAgreement path, not the no-op.
    mgr = default_transcription_manager()
    assert isinstance(mgr.backend, FakeAsrBackend)
    from loqui_sidecar.transcription.pipeline import StreamingTranscriptionPipeline

    pipeline = mgr._make_pipeline("m-1", "system", lambda _s: None, mgr.backend, mgr.config)
    assert isinstance(pipeline, StreamingTranscriptionPipeline)
    # No emitter wired -> emitting a segment from a pipeline is a safe no-op, and
    # silence frames never reach the backend (VAD drops leading silence).
    mgr.on_start("m-1", "system")
    mgr.on_frame("m-1", "system", _frame("system", 0))
    mgr.on_stop("m-1", "system")


def test_default_manager_selects_real_backend_without_fake_env(monkeypatch):
    # Without LOQUI_FAKE_ASR the production default selects the real
    # faster-whisper backend — constructed lazily (NO model load / download just
    # by constructing the manager). We assert the type without loading it.
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    from loqui_sidecar.transcription.asr_backend import FasterWhisperBackend

    mgr = default_transcription_manager()
    assert isinstance(mgr.backend, FasterWhisperBackend)
    assert mgr.backend.is_loaded is False  # lazy: nothing downloaded


def test_streaming_policy_protocol_is_checkable():
    # A minimal in-test policy must satisfy the Protocol via runtime_checkable.
    class MiniPolicy:
        def update(self, tokens):
            return PolicyResult(committed=tokens)

        def flush(self):
            return PolicyResult()

        def reset(self):
            pass

    assert isinstance(MiniPolicy(), StreamingPolicy)


# --- live speaker-bleed suppression (manager seam) ----------------------------


class _ScriptedEmitPipeline:
    """A pipeline whose ``feed`` emits ONE pre-scripted final segment. Lets a test
    drive the manager's emitter seam with exact (source, text, t_start, t_end)
    values so the bleed filter is exercised deterministically."""

    def __init__(self, emit, meeting_id, source, script):
        self._emit = emit
        self._meeting_id = meeting_id
        self._source = source
        self._script = script  # list of (text, t_start, t_end); one per fed frame
        self._i = 0

    def feed(self, frame):
        if self._i >= len(self._script):
            return
        text, t0, t1 = self._script[self._i]
        self._i += 1
        self._emit(
            TranscriptSegment(
                meeting_id=self._meeting_id,
                source=self._source,
                text=text,
                t_start=t0,
                t_end=t1,
                status="final",
                seg_id=f"{self._source}-{self._i}",
            )
        )

    def finish(self):
        pass


def _scripted_manager(scripts):
    """Build a manager whose per-source pipeline replays ``scripts[source]``."""
    emitted: list[TranscriptSegment] = []

    def factory(meeting_id, source, emit, backend, config):
        return _ScriptedEmitPipeline(emit, meeting_id, source, scripts.get(source, []))

    mgr = TranscriptionManager(emit=emitted.append, pipeline_factory=factory)
    return mgr, emitted


def test_manager_suppresses_mic_final_matching_recent_system_final():
    remote = "let's ship the release on Friday afternoon everyone"
    scripts = {
        "system": [(remote, 10.0, 13.0)],
        # A bleed twin of the system final + a genuinely distinct mic final.
        "mic": [
            (remote + "!", 10.1, 13.2),  # bleed: should be DROPPED
            ("sounds good I'll write the runbook tonight", 14.0, 16.0),  # distinct: KEPT
        ],
    }
    mgr, emitted = _scripted_manager(scripts)
    mgr.on_start("m1", "system")
    mgr.on_start("m1", "mic")
    # System final first so it lands in the ring before the mic bleed is filtered.
    mgr.on_frame("m1", "system", _frame("system", 0))
    mgr.on_frame("m1", "mic", _frame("mic", 0))  # bleed twin
    mgr.on_frame("m1", "mic", _frame("mic", 1))  # distinct
    mgr.on_stop("m1", "mic")
    mgr.on_stop("m1", "system")

    texts = [(s.source, s.text) for s in emitted]
    # The system final is emitted; the bleed mic twin is dropped; the distinct mic
    # final survives.
    assert ("system", remote) in texts
    assert ("mic", "sounds good I'll write the runbook tonight") in texts
    assert not any(src == "mic" and txt.startswith("let's ship") for src, txt in texts)
    assert mgr.bleed_suppressed == 1


def test_manager_partials_are_never_suppressed():
    # A mic PARTIAL matching a system final still emits (only finals persist / bleed).
    remote = "let's ship the release on Friday afternoon everyone"

    def factory(meeting_id, source, emit, backend, config):
        class P:
            def feed(self, frame):
                if source == "system":
                    emit(
                        TranscriptSegment(
                            meeting_id=meeting_id,
                            source="system",
                            text=remote,
                            t_start=10.0,
                            t_end=13.0,
                            status="final",
                            seg_id="sys-1",
                        )
                    )
                else:
                    emit(
                        TranscriptSegment(
                            meeting_id=meeting_id,
                            source="mic",
                            text=remote,
                            t_start=10.1,
                            t_end=13.2,
                            status="partial",
                            seg_id="mic-1",
                        )
                    )

            def finish(self):
                pass

        return P()

    emitted: list[TranscriptSegment] = []
    mgr = TranscriptionManager(emit=emitted.append, pipeline_factory=factory)
    mgr.on_start("m1", "system")
    mgr.on_start("m1", "mic")
    mgr.on_frame("m1", "system", _frame("system", 0))
    mgr.on_frame("m1", "mic", _frame("mic", 0))
    # The mic partial is emitted despite matching the system final.
    assert any(s.source == "mic" and s.status == "partial" for s in emitted)
    assert mgr.bleed_suppressed == 0


def test_manager_bleed_ring_cleared_between_meetings():
    remote = "let's ship the release on Friday afternoon everyone"
    scripts = {"system": [(remote, 10.0, 13.0)], "mic": []}
    mgr, _ = _scripted_manager(scripts)
    mgr.on_start("m1", "system")
    mgr.on_frame("m1", "system", _frame("system", 0))
    mgr.on_stop("m1", "system")  # meeting m1 fully stopped -> ring dropped
    assert "m1" not in mgr._bleed_ring
