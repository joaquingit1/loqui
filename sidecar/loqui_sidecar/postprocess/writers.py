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
#: High-accuracy re-transcription files (mirror of @loqui/shared
#: MEETING_HIFI_TRANSCRIPT_{JSONL,MD}_FILE). The `.md` mirrors transcript.live.md
#: line-for-line (`[hh:mm:ss] You/They said: …`) and the `.jsonl` mirrors
#: transcript.jsonl, so the store + diarization can consume them interchangeably.
MEETING_HIFI_JSONL = "transcript.hifi.jsonl"
MEETING_HIFI_MD = "transcript.hifi.md"

#: Speaker label by source for the rendered `.md` (mirror of @loqui/shared
#: SPEAKER_LABEL: mic = the local user "You", system = the remote side "They").
_SPEAKER_LABEL = {"mic": "You", "system": "They"}

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


# --- High-accuracy re-transcription output (PRD-2 two-tier) -------------------


def hifi_jsonl_path(meeting_id: str) -> Path:
    return _meeting_dir(meeting_id) / MEETING_HIFI_JSONL


def hifi_md_path(meeting_id: str) -> Path:
    return _meeting_dir(meeting_id) / MEETING_HIFI_MD


def _format_hifi_timestamp(seconds: float) -> str:
    """``hh:mm:ss`` clock for the ``[..]`` prefix (mirror of the TS
    ``formatTranscriptTimestamp``: clamp <=0/NaN to 0, hours grow past 2 digits)."""
    total = int(seconds) if isinstance(seconds, (int, float)) and seconds > 0 else 0
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def render_hifi_md(records: list[dict]) -> str:
    """Render hi-fi records to ``transcript.live.md``-identical Markdown.

    One line per record: ``[hh:mm:ss] You said: …`` (mic) / ``They said: …``
    (system) — byte-for-byte the shape of the TS ``formatTranscriptLine`` so the
    store can serve it as the "live" variant without the renderer noticing. Pure.
    """
    lines: list[str] = []
    for r in records:
        ts = _format_hifi_timestamp(float(r.get("tStart", 0.0)))
        who = _SPEAKER_LABEL.get(str(r.get("source", "")), "They")
        text = str(r.get("text", "")).replace("\r", " ").replace("\n", " ").rstrip()
        lines.append(f"[{ts}] {who} said: {text}")
    return "\n".join(lines) + ("\n" if lines else "")


def render_hifi_jsonl(records: list[dict]) -> str:
    """Render hi-fi records to ``transcript.jsonl``-identical JSONL (one compact
    JSON object per line, keys ``segId/source/tStart/tEnd/text``). Pure."""
    out: list[str] = []
    for r in records:
        rec = {
            "segId": str(r.get("segId", "")),
            "source": str(r.get("source", "")),
            "tStart": float(r.get("tStart", 0.0)),
            "tEnd": float(r.get("tEnd", 0.0)),
            "text": str(r.get("text", "")).replace("\r", " ").replace("\n", " ").rstrip(),
        }
        out.append(json.dumps(rec, ensure_ascii=False))
    return "\n".join(out) + ("\n" if out else "")


def write_hifi_transcript(meeting_id: str, records: list[dict]) -> None:
    """Persist the high-accuracy re-transcription as ``transcript.hifi.{jsonl,md}``
    (atomic; idempotently replaces any prior pass). Records are in wire shape
    ``{segId, source, tStart, tEnd, text}``, already time-ordered."""
    _atomic_write(hifi_jsonl_path(meeting_id), render_hifi_jsonl(records))
    _atomic_write(hifi_md_path(meeting_id), render_hifi_md(records))
