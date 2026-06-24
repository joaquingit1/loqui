"""Alignment (PURE) — assign diarized speaker turns to transcript segments by
timestamp overlap (whisperX-style). PRD-5.

This is the trickiest correctness surface that is NOT a model, so it is a PURE
function over the structured transcript records + the diarized speaker turns —
exhaustively unit-testable with no torch/pyannote/audio.

Contract (the seam the alignment build unit refines + the gate tests):

* mic segments are ALWAYS labeled ``"You"`` (the local user) — diarization runs
  only on the system stream.
* system segments are labeled ``"Speaker N"`` (1-based, first-appearance order)
  by which diarized turn they overlap most. When no turn overlaps (or
  diarization was skipped), a system segment falls back to ``"Speaker 1"`` so the
  meeting still completes with a coherent diarized transcript.
* Output preserves the transcript's segment order + ids (it is a re-labeling,
  not a re-segmentation) and is deterministic for given inputs (idempotent
  re-diarization yields identical output).

This module ships a correct, minimal reference implementation behind the fixed
signature so the gate + build units have a working baseline; the build unit may
refine the overlap heuristic (e.g. fractional-overlap weighting, gap handling)
WITHOUT changing the signature.
"""

from __future__ import annotations

from .types import (
    SPEAKER_LABEL_PREFIX,
    SPEAKER_YOU_LABEL,
    DiarizedSegment,
    SpeakerTurn,
    TranscriptRecord,
)


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Length of the overlap of ``[a_start, a_end)`` and ``[b_start, b_end)`` (>= 0)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def align(
    segments: list[TranscriptRecord],
    turns: list[SpeakerTurn],
) -> list[DiarizedSegment]:
    """Assign a speaker label to each transcript segment by timestamp overlap.

    PURE: no I/O, no model, deterministic. mic segments -> ``"You"``; system
    segments -> ``"Speaker N"`` by best-overlapping diarized turn (1-based,
    first-appearance order), falling back to ``"Speaker 1"`` when nothing
    overlaps. Returns one :class:`DiarizedSegment` per input segment, in input
    order, with ``display_name`` left None (renames are applied later by main).
    """
    # Map a raw diarizer cluster id -> a stable, first-appearance "Speaker N"
    # label. Built lazily so the labels reflect first appearance along the turns.
    cluster_to_label: dict[str, str] = {}

    def label_for_cluster(cluster: str) -> str:
        existing = cluster_to_label.get(cluster)
        if existing is not None:
            return existing
        label = f"{SPEAKER_LABEL_PREFIX} {len(cluster_to_label) + 1}"
        cluster_to_label[cluster] = label
        return label

    # Pre-walk turns in time order so first-appearance ordering is by turn start.
    for turn in sorted(turns, key=lambda t: (t.start, t.end)):
        label_for_cluster(turn.speaker)

    out: list[DiarizedSegment] = []
    for seg in segments:
        if seg.source == "mic":
            speaker = SPEAKER_YOU_LABEL
        else:
            best_cluster: str | None = None
            best_overlap = 0.0
            for turn in turns:
                ov = _overlap(seg.t_start, seg.t_end, turn.start, turn.end)
                if ov > best_overlap:
                    best_overlap = ov
                    best_cluster = turn.speaker
            if best_cluster is not None:
                speaker = label_for_cluster(best_cluster)
            else:
                # No overlapping turn (or no turns at all): fall back so the
                # system segment still gets a coherent label.
                speaker = f"{SPEAKER_LABEL_PREFIX} 1"
        out.append(
            DiarizedSegment(
                seg_id=seg.seg_id,
                source=seg.source,
                text=seg.text,
                t_start=seg.t_start,
                t_end=seg.t_end,
                speaker=speaker,
                display_name=None,
            )
        )
    return out


def distinct_system_speakers(segments: list[DiarizedSegment]) -> list[str]:
    """Distinct system-stream speaker labels in first-appearance order.

    Used to populate ``DiarizedTranscript.speakers`` + the ``postProcessDone``
    speaker list (so main can update ``meta.participants``). Excludes ``"You"``
    (the mic label is implicit).
    """
    seen: list[str] = []
    for seg in segments:
        if seg.source == "system" and seg.speaker not in seen:
            seen.append(seg.speaker)
    return seen
