"""Hermetic unit tests for the streaming VAD endpointer (PRD-2).

Pure synthetic signals (tone + silence + noise) — no model, no devices, no
network. Exercises segmentation, the silence hangover, empty/silent input,
multi-utterance splitting, robustness to arbitrary (incl. odd-byte) chunking,
and the aggressiveness knob.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the tests/fixtures package importable as `fixtures`.
sys.path.insert(0, str(Path(__file__).parent))

from fixtures import (  # noqa: E402
    concat,
    pcm_duration_seconds,
    silence,
    tone,
    white_noise,
)

from loqui_sidecar.transcription.vad import (  # noqa: E402
    SpeechSegment,
    StreamingVad,
    VadConfig,
)


def _segs(vad: StreamingVad, pcm: bytes) -> list[SpeechSegment]:
    return list(vad.iter_segments(pcm))


# -- basic segmentation -------------------------------------------------------


def test_single_utterance_between_silence():
    pcm = concat(silence(500), tone(800, freq=220, amplitude=0.5), silence(500))
    segs = _segs(StreamingVad(), pcm)
    assert len(segs) == 1
    seg = segs[0]
    # Speech starts ~0.5 s and the closed segment includes the hangover, so it
    # ends after the speech (1.3 s) but before the full buffer (1.8 s).
    assert seg.t_start == pytest.approx(0.5, abs=0.08)
    assert 1.3 <= seg.t_end <= pcm_duration_seconds(pcm)
    assert seg.duration > 0.7


def test_two_utterances_split_by_long_silence():
    pcm = concat(
        silence(300),
        tone(400, 220, 0.5),
        silence(600),  # > default 300 ms hangover -> splits the utterances
        tone(400, 220, 0.5),
        silence(300),
    )
    segs = _segs(StreamingVad(), pcm)
    assert len(segs) == 2
    assert segs[0].t_end < segs[1].t_start  # disjoint, ordered
    assert segs[0].t_start == pytest.approx(0.3, abs=0.08)
    assert segs[1].t_start == pytest.approx(1.3, abs=0.1)


def test_short_silence_does_not_split():
    # 100 ms gap < 300 ms hangover -> the two tones stay ONE segment.
    pcm = concat(
        silence(300),
        tone(300, 220, 0.5),
        silence(100),
        tone(300, 220, 0.5),
        silence(400),
    )
    segs = _segs(StreamingVad(), pcm)
    assert len(segs) == 1
    # One span covering both tones + the 100 ms internal gap (0.7 s) plus the
    # 300 ms trailing hangover ~= 1.0 s; the short gap did NOT split it.
    assert segs[0].t_start == pytest.approx(0.3, abs=0.08)
    assert segs[0].duration == pytest.approx(1.0, abs=0.12)


# -- endpoints / hangover -----------------------------------------------------


def test_segment_open_at_end_is_closed_on_flush():
    # Speech runs to the end of the buffer (no trailing silence) -> flush closes.
    pcm = concat(silence(300), tone(500, 220, 0.5))
    vad = StreamingVad()
    during = vad.feed(pcm)
    assert during == []  # no hangover silence yet -> nothing closed mid-stream
    after = vad.flush()
    assert len(after) == 1
    assert after[0].t_start == pytest.approx(0.3, abs=0.08)
    assert after[0].t_end == pytest.approx(pcm_duration_seconds(pcm), abs=0.03)


def test_hangover_is_included_in_segment_end():
    cfg = VadConfig(hangover_ms=200.0)
    pcm = concat(silence(200), tone(400, 220, 0.5), silence(500))
    segs = _segs(StreamingVad(cfg), pcm)
    assert len(segs) == 1
    # End = speech end (~0.6 s) + hangover (0.2 s) ~= 0.8 s, not the full 1.1 s.
    assert segs[0].t_end == pytest.approx(0.8, abs=0.08)


def test_short_blip_below_onset_is_ignored():
    # 40 ms tone < default 60 ms onset -> debounced, no segment.
    pcm = concat(silence(300), tone(40, 220, 0.5), silence(300))
    assert _segs(StreamingVad(), pcm) == []


# -- empty / silence / noise --------------------------------------------------


def test_pure_silence_yields_no_segments():
    assert _segs(StreamingVad(), silence(1000)) == []


def test_empty_input_is_safe():
    vad = StreamingVad()
    assert vad.feed(b"") == []
    assert vad.flush() == []


def test_low_amplitude_noise_is_not_speech():
    # Ambient hiss: high ZCR, low energy -> below threshold, no speech.
    assert _segs(StreamingVad(), white_noise(1000, amplitude=0.05)) == []


# -- chunking invariance ------------------------------------------------------


def test_chunked_feed_matches_one_shot():
    pcm = concat(silence(500), tone(800, 220, 0.5), silence(500))
    one_shot = _segs(StreamingVad(), pcm)

    vad = StreamingVad()
    chunked: list[SpeechSegment] = []
    for i in range(0, len(pcm), 777):  # arbitrary chunk size, not frame-aligned
        chunked += vad.feed(pcm[i : i + 777])
    chunked += vad.flush()

    assert [(round(s.t_start, 3), round(s.t_end, 3)) for s in chunked] == [
        (round(s.t_start, 3), round(s.t_end, 3)) for s in one_shot
    ]


def test_odd_byte_chunks_preserve_sample_alignment():
    # Feed odd-sized byte chunks (each leaves a ragged half-sample) to prove the
    # endpointer carries the lone byte forward and never desyncs alignment.
    pcm = concat(silence(500), tone(800, 220, 0.5), silence(500))
    vad = StreamingVad()
    out: list[SpeechSegment] = []
    for i in range(0, len(pcm), 333):  # odd step -> ragged trailing byte
        out += vad.feed(pcm[i : i + 333])
    out += vad.flush()
    assert len(out) == 1
    assert out[0].t_start == pytest.approx(0.5, abs=0.08)


# -- config knobs -------------------------------------------------------------


def test_aggressiveness_high_still_detects_loud_speech():
    cfg = VadConfig(aggressiveness=1.0)
    pcm = concat(silence(300), tone(500, 220, 0.8), silence(400))
    segs = _segs(StreamingVad(cfg), pcm)
    assert len(segs) == 1


def test_reset_clears_state():
    vad = StreamingVad()
    _segs(vad, concat(silence(300), tone(400, 220, 0.5), silence(400)))
    vad.reset()
    # A fresh stream starts at t=0 again.
    segs = _segs(vad, concat(silence(200), tone(400, 220, 0.5), silence(400)))
    assert len(segs) == 1
    assert segs[0].t_start == pytest.approx(0.2, abs=0.08)


def test_invalid_config_rejected():
    with pytest.raises(ValueError):
        VadConfig(aggressiveness=2.0)
    with pytest.raises(ValueError):
        VadConfig(frame_ms=0)


def test_speech_segment_duration_property():
    seg = SpeechSegment(t_start=1.0, t_end=2.5)
    assert seg.duration == pytest.approx(1.5)
