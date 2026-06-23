"""Re-export shim for the real ASR backend.

The Foundation contract (and the opt-in real-model smoke
``tests/test_asr_real_model.py`` + the package ``README.md``) reference the real
backend at :mod:`loqui_sidecar.transcription.asr_backend`. This module simply
re-exports those public symbols so ``transcription.asr`` and
``transcription.asr_backend`` are interchangeable import paths — the
implementation lives in :mod:`asr_backend` (lazy faster-whisper import; the
hermetic unit gate never touches it).
"""

from __future__ import annotations

from .asr_backend import (
    MODELS_DIR_NAME,
    FasterWhisperBackend,
    ProgressCallback,
)

__all__ = [
    "FasterWhisperBackend",
    "ProgressCallback",
    "MODELS_DIR_NAME",
]
