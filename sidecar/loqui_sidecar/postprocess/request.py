"""Decoded ``postProcess`` notification (main -> sidecar) — PRD-5.

Mirror of the TS ``PostProcessRequest`` (``packages/shared/src/postprocess.ts``).
The summary step reuses the PRD-4 provider layer, so this carries the same
provider config + transient BYOK ``api_key`` as a chat request; ``hf_token`` is
the transient Hugging Face token for the gated pyannote weights. Both secrets
are used transiently and NEVER persisted or logged.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from ..providers.types import ProviderConfig

DIARIZATION_BACKENDS = {"auto", "sherpa", "pyannote"}


@dataclass(frozen=True)
class Attendee:
    """One invited calendar participant (mirror of the TS context attendee)."""

    name: str = ""
    email: Optional[str] = None


@dataclass(frozen=True)
class MeetingContext:
    """Optional CALENDAR MEETING CONTEXT for the summary step (mirror of the TS
    ``PostProcessRequest.meetingContext``). Present when the meeting was launched
    from a calendar event; primes the notetaker prompt with the scheduled title,
    platform, start time, and invited participant names so it can use real names
    instead of "Speaker N". All fields default empty (manual / auto-record).
    """

    title: str = ""
    platform: str = ""
    started_at: str = ""
    attendees: list[Attendee] = field(default_factory=list)

    @classmethod
    def from_wire(cls, obj: Optional[dict]) -> "MeetingContext":
        if not isinstance(obj, dict):
            return cls()
        raw_attendees = obj.get("attendees")
        attendees: list[Attendee] = []
        if isinstance(raw_attendees, list):
            for a in raw_attendees:
                if isinstance(a, dict):
                    name = str(a.get("name", "")).strip()
                    raw_email = a.get("email")
                    email = (
                        str(raw_email).strip()
                        if isinstance(raw_email, str) and raw_email.strip()
                        else None
                    )
                    if name or email:
                        attendees.append(Attendee(name=name, email=email))
        return cls(
            title=str(obj.get("title", "")).strip(),
            platform=str(obj.get("platform", "")).strip(),
            started_at=str(obj.get("startedAt", "")).strip(),
            attendees=attendees,
        )

    def has_content(self) -> bool:
        return bool(self.title or self.platform or self.started_at or self.attendees)


@dataclass(frozen=True)
class PostProcessRequest:
    """A decoded ``postProcess`` notification.

    ``regenerate_summary`` runs ONLY the summary step (skipping diarization) for
    an already-diarized meeting; ``rediarize`` forces diarization to re-run even
    if prior diarized output exists (idempotent replace). ``re_transcribe`` runs
    the HIGH-ACCURACY re-transcription pass (PRD-2 two-tier) before diarization —
    re-decode the recorded WAVs with a larger model into ``transcript.hifi.*``.
    """

    meeting_id: str
    config: ProviderConfig
    api_key: Optional[str] = None
    hf_token: Optional[str] = None
    diarization_backend: str = "auto"
    regenerate_summary: bool = False
    rediarize: bool = False
    re_transcribe: bool = False
    meeting_context: MeetingContext = field(default_factory=MeetingContext)

    @classmethod
    def from_wire(cls, obj: dict) -> "PostProcessRequest":
        backend = str(obj.get("diarizationBackend", "auto"))
        if backend not in DIARIZATION_BACKENDS:
            backend = "auto"
        return cls(
            meeting_id=str(obj.get("meetingId", "")),
            config=ProviderConfig.from_wire(obj.get("providerConfig")),
            api_key=obj.get("apiKey"),
            hf_token=obj.get("hfToken"),
            diarization_backend=backend,
            regenerate_summary=bool(obj.get("regenerateSummary", False)),
            rediarize=bool(obj.get("rediarize", False)),
            re_transcribe=bool(obj.get("reTranscribe", False)),
            meeting_context=MeetingContext.from_wire(obj.get("meetingContext")),
        )
