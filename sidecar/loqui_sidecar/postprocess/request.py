"""Decoded ``postProcess`` notification (main -> sidecar) — PRD-5.

Mirror of the TS ``PostProcessRequest`` (``packages/shared/src/postprocess.ts``).
The summary step reuses the PRD-4 provider layer, so this carries the same
provider config + transient BYOK ``api_key`` as a chat request; ``hf_token`` is
the transient Hugging Face token for the gated pyannote weights. Both secrets
are used transiently and NEVER persisted or logged.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ..providers.types import ProviderConfig

DIARIZATION_BACKENDS = {"auto", "sherpa", "pyannote"}


@dataclass(frozen=True)
class PostProcessRequest:
    """A decoded ``postProcess`` notification.

    ``regenerate_summary`` runs ONLY the summary step (skipping diarization) for
    an already-diarized meeting; ``rediarize`` forces diarization to re-run even
    if prior diarized output exists (idempotent replace).
    """

    meeting_id: str
    config: ProviderConfig
    api_key: Optional[str] = None
    hf_token: Optional[str] = None
    diarization_backend: str = "auto"
    regenerate_summary: bool = False
    rediarize: bool = False

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
        )
