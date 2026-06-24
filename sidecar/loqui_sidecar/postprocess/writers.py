"""Derived-file writers (PRD-5): the SEPARATE files diarization + summary
produce. These are the ONLY writers in the postprocess package, and they write
ONLY the derived artifacts — NEVER ``transcript.live.md`` / ``transcript.jsonl``
/ ``meta.json`` (those are owned by main's TranscriptWriter/store). The live
transcript stays byte-identical after diarization + summary.

Paths mirror the TS store (honoring ``LOQUI_DATA_DIR``) so the sidecar writes
into the SAME ``<dataRoot>/meetings/<id>/`` dir main reads from:

    <id>/transcript.diarized.json   structured DiarizedTranscript
    <id>/transcript.diarized.md     human-facing diarized render
    <id>/summary.json               structured Summary

Writes are atomic (temp file + ``os.replace``) so a reader never sees a partial
file; re-running diarization/summary cleanly REPLACES the prior file
(idempotent re-diarization, PRD-5 AC#2).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from .types import DiarizedSegment, DiarizedTranscript, Summary

DATA_DIR_ENV = "LOQUI_DATA_DIR"
DEFAULT_DATA_DIR_NAME = "Loqui"
MEETINGS_DIR_NAME = "meetings"
MEETING_DIARIZED_JSON = "transcript.diarized.json"
MEETING_DIARIZED_MD = "transcript.diarized.md"
MEETING_SUMMARY = "summary.json"

#: Safe meeting-id guard (mirror of the TS store SAFE_ID + the provider reader).
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _data_root() -> Path:
    override = os.environ.get(DATA_DIR_ENV)
    if override and override.strip():
        return Path(override)
    return Path.home() / DEFAULT_DATA_DIR_NAME


def _meeting_dir(meeting_id: str) -> Path:
    if not _SAFE_ID.match(meeting_id) or meeting_id in (".", ".."):
        raise ValueError(f"invalid meeting id {meeting_id!r}")
    return _data_root() / MEETINGS_DIR_NAME / meeting_id


def diarized_json_path(meeting_id: str) -> Path:
    return _meeting_dir(meeting_id) / MEETING_DIARIZED_JSON


def diarized_md_path(meeting_id: str) -> Path:
    return _meeting_dir(meeting_id) / MEETING_DIARIZED_MD


def summary_path(meeting_id: str) -> Path:
    return _meeting_dir(meeting_id) / MEETING_SUMMARY


def _atomic_write(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically (temp file + replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _speaker_display(seg: DiarizedSegment) -> str:
    """The name to show for a segment: the rename if present, else the label."""
    return seg.display_name or seg.speaker


def render_diarized_md(diarized: DiarizedTranscript) -> str:
    """Render a :class:`DiarizedTranscript` to its human-facing Markdown.

    One line per segment: ``[hh:mm:ss] <speaker>: <text>``. Pure (no I/O) so it
    is unit-testable and reusable when a rename re-renders the ``.md``.
    """
    lines: list[str] = []
    for seg in diarized.segments:
        total = int(seg.t_start) if seg.t_start and seg.t_start > 0 else 0
        h, m, s = total // 3600, (total % 3600) // 60, total % 60
        ts = f"{h:02d}:{m:02d}:{s:02d}"
        who = _speaker_display(seg)
        text = seg.text.replace("\r", " ").replace("\n", " ").rstrip()
        lines.append(f"[{ts}] {who}: {text}")
    return "\n".join(lines) + ("\n" if lines else "")


def write_diarized_transcript(diarized: DiarizedTranscript) -> None:
    """Persist a :class:`DiarizedTranscript` as JSON + rendered Markdown
    (atomic; idempotently replaces prior output)."""
    _atomic_write(
        diarized_json_path(diarized.meeting_id),
        json.dumps(diarized.to_wire(), ensure_ascii=False, indent=2) + "\n",
    )
    _atomic_write(diarized_md_path(diarized.meeting_id), render_diarized_md(diarized))


def write_summary(summary: Summary) -> None:
    """Persist a :class:`Summary` as ``summary.json`` (atomic; replaces prior)."""
    _atomic_write(
        summary_path(summary.meeting_id),
        json.dumps(summary.to_wire(), ensure_ascii=False, indent=2) + "\n",
    )
