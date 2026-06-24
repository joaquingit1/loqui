"""READ-ONLY transcript accessor for the chat/provider layer (PRD-4).

This is the ONLY transcript surface the chat layer touches. It opens the
per-meeting transcript file with ``open(..., "r")`` and returns its text — there
is deliberately NO write path here. The chat handler builds the provider context
from this and nothing else, structurally enforcing the cross-cutting invariant
that **the AI never edits the transcript**.

Path resolution mirrors the TS store (``apps/desktop/src/main/store/paths.ts``)
and honors ``LOQUI_DATA_DIR`` so tests stay hermetic and never touch the real
``~/Loqui``:

    <LOQUI_DATA_DIR>/meetings/<id>/transcript.live.md      (variant="live")
    <LOQUI_DATA_DIR>/meetings/<id>/transcript.jsonl        (variant="structured")

The diarized variants land in PRD-5; when one exists the build unit may extend
``read`` to prefer it, but the accessor stays read-only.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

logger = logging.getLogger("loqui_sidecar.providers.transcript")

#: Env var that overrides the data root (mirror of @loqui/shared DATA_DIR_ENV).
DATA_DIR_ENV = "LOQUI_DATA_DIR"
#: Default data-root dir name under the user's home (mirror of DEFAULT_DATA_DIR_NAME).
DEFAULT_DATA_DIR_NAME = "Loqui"
MEETINGS_DIR_NAME = "meetings"
MEETING_LIVE_TRANSCRIPT_FILE = "transcript.live.md"
MEETING_TRANSCRIPT_FILE = "transcript.jsonl"

#: A meeting id must be a safe path segment (mirror of the TS store's SAFE_ID) so
#: an adversarial id from the renderer cannot escape the meetings dir.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def data_root() -> Path:
    """Absolute data root. Override via ``LOQUI_DATA_DIR``; else ``~/Loqui``."""
    override = os.environ.get(DATA_DIR_ENV)
    if override and override.strip():
        return Path(override)
    return Path.home() / DEFAULT_DATA_DIR_NAME


def meeting_transcript_path(meeting_id: str, variant: str = "live") -> Path:
    """Absolute path to a meeting's transcript file for ``variant`` (no I/O)."""
    if not _SAFE_ID.match(meeting_id) or meeting_id in (".", ".."):
        raise ValueError(f"invalid meeting id {meeting_id!r}")
    name = MEETING_TRANSCRIPT_FILE if variant == "structured" else MEETING_LIVE_TRANSCRIPT_FILE
    return data_root() / MEETINGS_DIR_NAME / meeting_id / name


class FsTranscriptReader:
    """Default :class:`~loqui_sidecar.providers.types.TranscriptReader`.

    Reads the on-disk transcript file READ-ONLY. Returns ``""`` when the file
    does not exist (e.g. a meeting with no confirmed segments yet). Has no write
    method — by construction the chat/provider layer cannot mutate a transcript.
    """

    def read(self, meeting_id: str, variant: str = "live") -> str:
        path = meeting_transcript_path(meeting_id, variant)
        try:
            # READ-ONLY: "r" mode, no write counterpart anywhere in this class.
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""
        except OSError:
            logger.exception("transcript read failed for %s (%s)", meeting_id, variant)
            return ""


def default_transcript_reader() -> FsTranscriptReader:
    """Construct the live read-only transcript accessor."""
    return FsTranscriptReader()
