"""PyannoteDiarizer — the REAL offline DiarizationBackend (PRD-5 build unit seam).

Pinned to **pyannote.audio 3.1** (``speaker-diarization-3.1``): MIT-licensed and
CPU-capable. Sortformer is excluded (needs an NVIDIA GPU). torch + pyannote.audio
are an OPTIONAL uv dependency-group (``[dependency-groups] diarization``) — NOT
in the default sync — so the base env + the hermetic gate stay lean.

GRACEFUL DEGRADATION (PRD-5 AC#4): if torch/pyannote is not installed, or no
Hugging Face token is configured (the weights are gated), or the WAV is missing,
:meth:`diarize` returns ``DiarizationResult(diarized=False, note=<reason>)``
rather than raising — the meeting still completes with the live transcript +
summary and diarization is marked skipped.

This module is import-light: torch + pyannote are imported LAZILY inside
:meth:`diarize` (never at module import), so importing the postprocess package
for the fake-only gate pulls in neither.

HONEST DEFERRAL: the real path (needs the gated model terms accepted + a token +
torch + multi-speaker audio) is verified MANUALLY / by an opt-in test; the
automated gate covers FakeDiarizer + real alignment + graceful degradation. The
Build phase fills in the body below behind this fixed signature.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from .types import DiarizationResult, SpeakerTurn

logger = logging.getLogger("loqui_sidecar.postprocess.pyannote")

#: The pinned pyannote pipeline id (3.1). NOT Sortformer.
PYANNOTE_PIPELINE = "pyannote/speaker-diarization-3.1"


class DiarizationUnavailable(RuntimeError):
    """Raised when the real diarization backend cannot run (torch/pyannote not
    installed, no HF token, or the gated weights could not be loaded).

    The pipeline catches this at the seam and DEGRADES GRACEFULLY (the meeting
    still completes with the live transcript + summary); it is surfaced directly
    only by the opt-in real-diarization test, which wants an actionable failure
    rather than a silent skip. The message is ALWAYS secret-free (it never
    contains the HF token).
    """


class PyannoteDiarizer:
    """Real pyannote.audio 3.1 diarizer. Lazy-imports torch + pyannote; degrades
    gracefully when they (or the HF token / WAV) are unavailable.
    """

    name = PYANNOTE_PIPELINE

    def diarize(self, wav_path: str, hf_token: Optional[str] = None) -> DiarizationResult:
        # Missing WAV -> skip (the parent finalized audio before postProcess, but
        # be defensive). Never raise.
        if not wav_path or not os.path.exists(wav_path):
            return DiarizationResult(
                diarized=False,
                backend=self.name,
                note=f"diarization skipped: audio file not found ({wav_path})",
            )

        # The gated weights need a Hugging Face token + accepting the model terms.
        if not hf_token:
            return DiarizationResult(
                diarized=False,
                backend=self.name,
                note=(
                    "diarization skipped: no Hugging Face token configured. "
                    "Add one in Settings and accept the pyannote model terms."
                ),
            )

        # Lazy import — torch + pyannote are an optional dependency-group, absent
        # from the default sync. ImportError => degrade gracefully.
        try:
            import torch  # type: ignore[import-not-found]
            from pyannote.audio import Pipeline  # type: ignore[import-not-found]
        except Exception as exc:  # noqa: BLE001 - any import failure degrades.
            logger.info("pyannote unavailable; diarization skipped: %s", exc)
            return DiarizationResult(
                diarized=False,
                backend=self.name,
                note=(
                    "diarization skipped: torch + pyannote.audio are not installed. "
                    "Install the optional 'diarization' dependency group."
                ),
            )

        # --- Real pyannote.audio 3.1 run (CPU) --------------------------------
        # Any model-load / runtime failure raises DiarizationUnavailable (an
        # actionable, secret-free error the opt-in real test asserts on); here we
        # catch it and DEGRADE GRACEFULLY so the meeting still completes. The HF
        # token is used transiently and NEVER logged / put in the note.
        try:
            turns = self._run(Pipeline, torch, wav_path, hf_token)
        except DiarizationUnavailable as exc:
            logger.info("pyannote diarization skipped for %s: %s", wav_path, exc)
            return DiarizationResult(diarized=False, backend=self.name, note=str(exc))
        except Exception:  # noqa: BLE001 - any unexpected failure degrades, never fatal.
            logger.exception("pyannote diarization crashed for %s", wav_path)
            return DiarizationResult(
                diarized=False,
                backend=self.name,
                note="diarization skipped: the pyannote pipeline failed to run.",
            )

        return DiarizationResult(turns=turns, diarized=True, backend=self.name, note="")

    @staticmethod
    def _run(Pipeline, torch, wav_path: str, hf_token: str) -> list[SpeakerTurn]:
        """Load the gated pyannote pipeline and run it on ``wav_path`` (CPU).

        Returns the speaker turns in pipeline order; raises
        :class:`DiarizationUnavailable` (secret-free) on a load/run failure. Kept
        separate from :meth:`diarize` so the graceful-degradation wrapper stays
        one obvious layer and so the opt-in real test can exercise it directly.
        """
        try:
            pipeline = Pipeline.from_pretrained(PYANNOTE_PIPELINE, use_auth_token=hf_token)
        except Exception as exc:  # noqa: BLE001 - normalize to a secret-free error.
            raise DiarizationUnavailable(
                "diarization skipped: could not load the pyannote weights. Verify "
                "your Hugging Face token and that you accepted the model terms at "
                f"https://huggingface.co/{PYANNOTE_PIPELINE}."
            ) from exc
        if pipeline is None:
            # from_pretrained returns None on an auth/terms problem rather than raising.
            raise DiarizationUnavailable(
                "diarization skipped: the pyannote pipeline could not be initialized. "
                "Accept the model terms at "
                f"https://huggingface.co/{PYANNOTE_PIPELINE} and check your token."
            )

        # Pin to CPU (Sortformer/GPU is out of scope; pyannote 3.1 is CPU-capable).
        try:
            pipeline.to(torch.device("cpu"))
        except Exception:  # noqa: BLE001 - .to is best-effort; default device is fine.
            logger.debug("pipeline.to(cpu) failed; using default device")

        annotation = pipeline(wav_path)
        turns: list[SpeakerTurn] = [
            SpeakerTurn(start=float(segment.start), end=float(segment.end), speaker=str(label))
            for segment, _track, label in annotation.itertracks(yield_label=True)
        ]
        # Stable, deterministic order (idempotent re-diarization): by time.
        turns.sort(key=lambda t: (t.start, t.end, t.speaker))
        return turns


def pyannote_factory() -> PyannoteDiarizer:
    """Construct the real diarizer (used by the production diarizer selector)."""
    return PyannoteDiarizer()
