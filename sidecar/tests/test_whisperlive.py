"""WhisperLive live-engine tests (hermetic — no model, no thread timing).

Covers the parts that matter without the timing-dependent background loop:
* the WhisperLive segment-commit core (`_update_segments` / `_handle_output`)
  driven by a scripted fake faster-whisper result;
* the pipeline adapter's mapping of WhisperLive segments -> Loqui partial/final
  TranscriptSegments (stable seg ids, partial superseded by its final, finish
  flushes the trailing tail);
* the factory selecting the WhisperLive pipeline only for a backend that exposes
  `transcribe_raw` (the real faster-whisper), keeping fakes on the old pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass

from loqui_sidecar.transcription import TranscriptSegment
from loqui_sidecar.transcription.pipeline import (
    StreamingTranscriptionPipeline,
    make_pipeline_factory,
)
from loqui_sidecar.transcription.whisperlive_core import WhisperLiveTranscriber
from loqui_sidecar.transcription.whisperlive_pipeline import WhisperLiveTranscriptionPipeline


@dataclass
class _Seg:
    start: float
    end: float
    text: str
    no_speech_prob: float = 0.0


@dataclass
class _Info:
    language: str = "en"
    language_probability: float = 0.99


class _FakeModel:
    """A faster-whisper-shaped model: transcribe() -> (segments, info)."""

    def __init__(self, script):
        self._script = script
        self.calls = 0

    def transcribe(self, audio, **kwargs):
        i = self.calls
        self.calls += 1
        segs = self._script[i] if i < len(self._script) else []
        return segs, _Info()


# --- the segment-commit core --------------------------------------------------


def test_core_commits_full_segments_and_keeps_tail_incomplete():
    results: list[list[dict]] = []
    t = WhisperLiveTranscriber(
        model=_FakeModel([]),
        on_result=results.append,
        language="en",
        start=False,  # drive _handle_output directly, no thread
    )
    # Two segments in one decode: the first commits (completed), the last is the
    # in-progress tail.
    t._handle_output([_Seg(0.0, 1.0, "hello world"), _Seg(1.0, 2.0, "and then")], duration=2.0)
    assert results, "expected an on_result emission"
    segs = results[-1]
    completed = [s for s in segs if s["completed"]]
    tail = [s for s in segs if not s["completed"]]
    assert [s["text"] for s in completed] == ["hello world"]
    assert tail and tail[0]["text"] == "and then"
    # The committed segment advanced timestamp_offset.
    assert t.timestamp_offset >= 1.0


# --- the pipeline adapter mapping ---------------------------------------------


def _pipe(emitted):
    # A backend stub is required by the ctor but unused when we call _on_result.
    class _B:
        def transcribe_raw(self, *a, **k):  # pragma: no cover - not exercised here
            return [], _Info()

    return WhisperLiveTranscriptionPipeline("m1", "mic", emitted.append, _B(), language="en")


def test_pipeline_emits_final_for_completed_and_partial_for_tail():
    emitted: list[TranscriptSegment] = []
    pipe = _pipe(emitted)
    pipe._on_result(
        [
            {"start": 0.0, "end": 1.0, "text": "hello world", "completed": True},
            {"start": 1.0, "end": 2.0, "text": "and then", "completed": False},
        ]
    )
    finals = [s for s in emitted if s.status == "final"]
    partials = [s for s in emitted if s.status == "partial"]
    assert [s.text for s in finals] == ["hello world"]
    assert finals[0].seg_id == "m1:mic:0"
    assert finals[0].t_start == 0.0 and finals[0].t_end == 1.0
    # The tail partial takes the NEXT-to-commit seg id, so its later final
    # supersedes it in place.
    assert partials and partials[-1].text == "and then"
    assert partials[-1].seg_id == "m1:mic:1"


def test_pipeline_partial_then_its_final_share_a_seg_id_and_dedup():
    emitted: list[TranscriptSegment] = []
    pipe = _pipe(emitted)
    pipe._on_result([{"start": 1.0, "end": 2.0, "text": "and then", "completed": False}])
    # The tail later commits.
    pipe._on_result([{"start": 1.0, "end": 2.0, "text": "and then we shipped", "completed": True}])
    # Re-delivery of the same completed segment must not double-emit.
    pipe._on_result([{"start": 1.0, "end": 2.0, "text": "and then we shipped", "completed": True}])
    partials = [s for s in emitted if s.status == "partial"]
    finals = [s for s in emitted if s.status == "final"]
    assert partials[0].seg_id == "m1:mic:0"
    assert len(finals) == 1
    assert finals[0].seg_id == "m1:mic:0"  # same id -> supersedes the partial
    assert finals[0].text == "and then we shipped"


def test_pipeline_finish_flushes_trailing_partial_as_final():
    emitted: list[TranscriptSegment] = []
    pipe = _pipe(emitted)
    pipe._on_result([{"start": 0.0, "end": 1.5, "text": "last words", "completed": False}])
    pipe.finish()
    finals = [s for s in emitted if s.status == "final"]
    assert finals and finals[-1].text == "last words"
    assert finals[-1].seg_id == "m1:mic:0"


# --- factory selection --------------------------------------------------------


def test_factory_picks_whisperlive_only_for_transcribe_raw_backend():
    factory = make_pipeline_factory()

    class _RawBackend:
        def transcribe_raw(self, *a, **k):
            return [], _Info()

    class _PlainBackend:  # the fake / native shape (no transcribe_raw)
        name = "fake"
        is_loaded = True

        def load(self):
            pass

        def transcribe(self, *a, **k):
            return []

    wl = factory("m1", "mic", lambda _s: None, _RawBackend(), None)
    old = factory("m1", "mic", lambda _s: None, _PlainBackend(), None)
    assert isinstance(wl, WhisperLiveTranscriptionPipeline)
    assert isinstance(old, StreamingTranscriptionPipeline)
