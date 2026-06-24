"""Exhaustive unit tests for the PURE alignment function (PRD-5).

``align(segments, turns)`` is the trickiest correctness surface that is NOT a
model, so it is a pure function over the structured transcript records + the
diarized speaker turns — and exhaustively unit-tested here with NO
torch/pyannote/audio/network/disk.

Contract under test (mirrors the seam docstring):

* mic-source segments are ALWAYS labeled ``"You"`` (diarization runs only on the
  system stream).
* system-source segments are labeled ``"Speaker N"`` (1-based, first-appearance
  order) by the diarized turn they overlap MOST (by overlap length).
* gaps / no-overlap / no-turns fall back to ``"Speaker 1"`` so the meeting still
  completes with a coherent diarized transcript.
* output preserves input order + ids (re-labeling, not re-segmentation) and is
  deterministic / idempotent.
"""

from __future__ import annotations

from loqui_sidecar.postprocess import (
    SPEAKER_YOU_LABEL,
    DiarizedSegment,
    SpeakerTurn,
    TranscriptRecord,
    align,
    distinct_system_speakers,
)


def _seg(seg_id, source, t_start, t_end, text="x"):
    return TranscriptRecord(seg_id=seg_id, source=source, t_start=t_start, t_end=t_end, text=text)


# --- mic is always "You" ------------------------------------------------------


def test_mic_segments_always_you_even_when_turns_overlap():
    # A turn covers the mic segment's window, but mic must stay "You".
    segs = [_seg("s1", "mic", 0.0, 5.0)]
    turns = [SpeakerTurn(0.0, 5.0, "spk_0")]
    out = align(segs, turns)
    assert [d.speaker for d in out] == [SPEAKER_YOU_LABEL]


def test_mic_segments_you_with_no_turns():
    segs = [_seg("s1", "mic", 0.0, 5.0)]
    out = align(segs, [])
    assert out[0].speaker == SPEAKER_YOU_LABEL
    assert out[0].source == "mic"


# --- system overlap assignment ------------------------------------------------


def test_system_segment_assigned_by_overlap():
    segs = [_seg("s1", "system", 1.0, 2.0)]
    turns = [SpeakerTurn(0.0, 3.0, "spk_7")]
    out = align(segs, turns)
    assert out[0].speaker == "Speaker 1"


def test_system_segment_picks_max_overlap_turn():
    # Segment 2..6 overlaps spk_a for 1s (2..3) and spk_b for 3s (3..6): spk_b wins.
    segs = [_seg("s1", "system", 2.0, 6.0)]
    turns = [
        SpeakerTurn(0.0, 3.0, "spk_a"),
        SpeakerTurn(3.0, 9.0, "spk_b"),
    ]
    out = align(segs, turns)
    # spk_a appears first in time so is "Speaker 1"; spk_b is "Speaker 2".
    assert out[0].speaker == "Speaker 2"


def test_two_remote_speakers_distinguished():
    segs = [
        _seg("s1", "system", 0.5, 2.5),
        _seg("s2", "system", 3.5, 5.5),
        _seg("s3", "system", 6.5, 8.5),
    ]
    turns = [
        SpeakerTurn(0.0, 3.0, "spk_0"),
        SpeakerTurn(3.0, 6.0, "spk_1"),
        SpeakerTurn(6.0, 9.0, "spk_0"),
    ]
    out = align(segs, turns)
    assert [d.speaker for d in out] == ["Speaker 1", "Speaker 2", "Speaker 1"]


# --- stable, first-appearance numbering ---------------------------------------


def test_stable_numbering_by_first_appearance_in_time_not_segment_order():
    # The first *segment* overlaps the later-in-time cluster, but numbering is by
    # the turn's first appearance in TIME -> spk_early is always Speaker 1.
    segs = [
        _seg("s1", "system", 6.0, 7.0),  # overlaps spk_late
        _seg("s2", "system", 1.0, 2.0),  # overlaps spk_early
    ]
    turns = [
        SpeakerTurn(0.0, 3.0, "spk_early"),
        SpeakerTurn(5.0, 8.0, "spk_late"),
    ]
    out = align(segs, turns)
    assert out[0].speaker == "Speaker 2"  # spk_late
    assert out[1].speaker == "Speaker 1"  # spk_early


def test_numbering_assigns_consecutive_labels():
    segs = [
        _seg("a", "system", 0.5, 1.5),
        _seg("b", "system", 10.5, 11.5),
        _seg("c", "system", 20.5, 21.5),
    ]
    turns = [
        SpeakerTurn(0.0, 2.0, "x"),
        SpeakerTurn(10.0, 12.0, "y"),
        SpeakerTurn(20.0, 22.0, "z"),
    ]
    out = align(segs, turns)
    assert [d.speaker for d in out] == ["Speaker 1", "Speaker 2", "Speaker 3"]


# --- gaps / no overlap / unknown ----------------------------------------------


def test_system_segment_in_gap_falls_back_to_speaker_1():
    # Segment sits in the silence gap between two turns -> no overlap -> Speaker 1.
    segs = [_seg("s1", "system", 3.2, 3.8)]
    turns = [
        SpeakerTurn(0.0, 3.0, "spk_0"),
        SpeakerTurn(4.0, 7.0, "spk_1"),
    ]
    out = align(segs, turns)
    assert out[0].speaker == "Speaker 1"


def test_system_segment_with_no_turns_falls_back_to_speaker_1():
    segs = [_seg("s1", "system", 0.0, 5.0)]
    out = align(segs, [])
    assert out[0].speaker == "Speaker 1"


def test_zero_overlap_touching_edges_is_not_a_match():
    # Turn ends exactly when the segment starts: half-open intervals => 0 overlap.
    segs = [_seg("s1", "system", 3.0, 5.0)]
    turns = [SpeakerTurn(0.0, 3.0, "spk_0")]
    out = align(segs, turns)
    assert out[0].speaker == "Speaker 1"  # fallback, not the touching turn


# --- overlapping turns --------------------------------------------------------


def test_overlapping_turns_max_overlap_wins():
    # Two turns overlap each other; the segment overlaps spk_b more.
    segs = [_seg("s1", "system", 4.0, 6.0)]
    turns = [
        SpeakerTurn(0.0, 5.0, "spk_a"),  # overlap with seg: 4..5 = 1s
        SpeakerTurn(3.0, 9.0, "spk_b"),  # overlap with seg: 4..6 = 2s
    ]
    out = align(segs, turns)
    assert out[0].speaker == "Speaker 2"  # spk_b (appears second in time)


# --- order + id preservation + idempotency ------------------------------------


def test_output_preserves_segment_order_ids_text_and_timestamps():
    segs = [
        _seg("alpha", "mic", 0.0, 1.0, "hello"),
        _seg("beta", "system", 1.0, 4.0, "world"),
    ]
    turns = [SpeakerTurn(1.0, 4.0, "spk_0")]
    out = align(segs, turns)
    assert [d.seg_id for d in out] == ["alpha", "beta"]
    assert [d.source for d in out] == ["mic", "system"]
    assert [d.text for d in out] == ["hello", "world"]
    assert out[0].t_start == 0.0 and out[1].t_end == 4.0
    assert all(d.display_name is None for d in out)
    assert all(isinstance(d, DiarizedSegment) for d in out)


def test_alignment_is_idempotent_deterministic():
    segs = [
        _seg("s1", "system", 0.5, 2.5),
        _seg("s2", "mic", 2.5, 4.0),
        _seg("s3", "system", 3.5, 5.5),
    ]
    turns = [
        SpeakerTurn(0.0, 3.0, "spk_0"),
        SpeakerTurn(3.0, 6.0, "spk_1"),
    ]
    first = [d.to_wire() for d in align(segs, turns)]
    second = [d.to_wire() for d in align(segs, turns)]
    assert first == second


def test_empty_segments_yields_empty_output():
    assert align([], [SpeakerTurn(0.0, 1.0, "x")]) == []


# --- distinct_system_speakers -------------------------------------------------


def test_distinct_system_speakers_first_appearance_order_excludes_you():
    segs = [
        _seg("s1", "mic", 0.0, 1.0),
        _seg("s2", "system", 1.0, 4.0),
        _seg("s3", "system", 4.0, 7.0),
        _seg("s4", "system", 7.0, 10.0),
    ]
    turns = [
        SpeakerTurn(1.0, 4.0, "spk_0"),
        SpeakerTurn(4.0, 7.0, "spk_1"),
        SpeakerTurn(7.0, 10.0, "spk_0"),
    ]
    out = align(segs, turns)
    speakers = distinct_system_speakers(out)
    assert speakers == ["Speaker 1", "Speaker 2"]
    assert SPEAKER_YOU_LABEL not in speakers


def test_distinct_system_speakers_empty_when_only_mic():
    segs = [_seg("s1", "mic", 0.0, 1.0), _seg("s2", "mic", 1.0, 2.0)]
    out = align(segs, [])
    assert distinct_system_speakers(out) == []
