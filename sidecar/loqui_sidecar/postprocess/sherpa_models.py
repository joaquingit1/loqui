"""Model resolution + first-run fetch for the no-token sherpa-onnx diarizer (PRD-14).

sherpa-onnx (k2-fsa) ships **Apache-2.0** ONNX diarization models on its OWN
GitHub releases — no Hugging Face token, no account, redistributable (so PRD-8
packaging can BUNDLE them). The default diarizer (``SherpaOnnxDiarizer``) needs
two ONNX files:

* a pyannote-style **segmentation** model (~7 MB .tar.bz2) — finds speech regions, and
* a **speaker-embedding** model (3D-Speaker CAM++, ~15 MB) — clusters speakers.

This module centralizes WHERE those files live (a cache dir under the Loqui data
dir, honoring ``LOQUI_DATA_DIR``) and WHERE they come from (the non-gated
sherpa-onnx release URLs), as MODULE CONSTANTS so PRD-8 packaging can pre-stage
them into the same cache dir and the first-run fetch becomes a no-op.

NETWORK IS STRICTLY OUT OF THE HERMETIC GATE: :func:`resolve_models` only ever
returns already-present files (no download); the actual download lives in
:func:`fetch_models`, which the gate NEVER calls (the unit tests stub the model
paths / mock the package). Nothing here imports ``sherpa_onnx`` — model
RESOLUTION is decoupled from model RUNTIME so importing this stays light.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("loqui_sidecar.postprocess.sherpa_models")

#: Env var that overrides the data root (mirror of @loqui/shared DATA_DIR_ENV).
DATA_DIR_ENV = "LOQUI_DATA_DIR"
#: Default data-root dir name under the user's home (mirror of DEFAULT_DATA_DIR_NAME).
DEFAULT_DATA_DIR_NAME = "Loqui"
#: Sub-dir (under the data root) where the bundled/first-run-fetched ONNX models cache.
MODELS_DIR_NAME = "models"
#: Sub-dir (under models/) for the diarization ONNX files specifically.
DIARIZATION_DIR_NAME = "diarization"

#: Env var to OVERRIDE the diarization model cache dir directly (used by tests +
#: by PRD-8 packaging to point at the bundled-models location). Wins over the
#: data-dir-derived default when set.
SHERPA_MODELS_DIR_ENV = "LOQUI_SHERPA_MODELS_DIR"
#: Env var that disables first-run model download (used by the hermetic gate).
NO_MODEL_DOWNLOAD_ENV = "LOQUI_NO_MODEL_DOWNLOAD"


@dataclass(frozen=True)
class SherpaModelSpec:
    """One ONNX model to resolve/fetch: its on-disk filename + non-gated URL.

    ``url`` points at a sherpa-onnx GitHub release asset (Apache-2.0, no HF
    token/account). ``filename`` is the name under the diarization cache dir.
    ``archive_member`` is set when the published asset is an archive containing
    the ONNX model rather than a bare ONNX file.
    """

    filename: str
    url: str
    archive_member: Optional[str] = None


#: The pyannote-style SEGMENTATION model (Apache-2.0, ~7 MB .tar.bz2) — sherpa-onnx release.
SEGMENTATION_MODEL = SherpaModelSpec(
    filename="sherpa-onnx-pyannote-segmentation-3-0.onnx",
    url=(
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
        "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    ),
    archive_member="sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
)

#: The SPEAKER-EMBEDDING model (3D-Speaker CAM++, Apache-2.0, ~15 MB) — sherpa-onnx release.
EMBEDDING_MODEL = SherpaModelSpec(
    filename="3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    url=(
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
        "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
    ),
)


@dataclass(frozen=True)
class ResolvedSherpaModels:
    """Absolute paths to the two resolved ONNX models (both confirmed present)."""

    segmentation: str
    embedding: str


def data_root() -> Path:
    """Absolute data root. Override via ``LOQUI_DATA_DIR``; else ``~/Loqui``."""
    override = os.environ.get(DATA_DIR_ENV)
    if override and override.strip():
        return Path(override)
    return Path.home() / DEFAULT_DATA_DIR_NAME


def models_cache_dir() -> Path:
    """Absolute cache dir for the diarization ONNX models.

    ``LOQUI_SHERPA_MODELS_DIR`` overrides it directly (tests + PRD-8 bundling);
    else ``<dataRoot>/models/diarization``. No I/O — pure path computation.
    """
    override = os.environ.get(SHERPA_MODELS_DIR_ENV)
    if override and override.strip():
        return Path(override)
    return data_root() / MODELS_DIR_NAME / DIARIZATION_DIR_NAME


def segmentation_model_path() -> Path:
    """Absolute path the segmentation ONNX model resolves to (may not yet exist)."""
    return models_cache_dir() / SEGMENTATION_MODEL.filename


def embedding_model_path() -> Path:
    """Absolute path the speaker-embedding ONNX model resolves to (may not yet exist)."""
    return models_cache_dir() / EMBEDDING_MODEL.filename


def resolve_models() -> Optional[ResolvedSherpaModels]:
    """Return the two model paths IFF both already exist on disk; else ``None``.

    PURE resolution — NEVER downloads (so the hermetic gate, which has no models,
    deterministically gets ``None`` and the diarizer degrades gracefully). The
    one-time fetch is the explicit, gate-excluded :func:`fetch_models`.
    """
    seg = segmentation_model_path()
    emb = embedding_model_path()
    if seg.is_file() and emb.is_file():
        return ResolvedSherpaModels(segmentation=str(seg), embedding=str(emb))
    return None


def model_download_disabled() -> bool:
    """Whether first-run model download is disabled for this process."""
    if os.environ.get(NO_MODEL_DOWNLOAD_ENV, "").strip() not in {"", "0", "false", "False"}:
        return True
    if os.environ.get("LOQUI_FAKE_DIARIZER", "").strip():
        return True
    return bool(os.environ.get(SHERPA_MODELS_DIR_ENV, "").strip())


def fetch_models(*, timeout: float = 120.0) -> Optional[ResolvedSherpaModels]:
    """Download any missing ONNX model into the cache dir, then resolve.

    NON-GATED source (sherpa-onnx GitHub releases — Apache-2.0, no HF token /
    account). This is the ONLY function here that touches the network and it is
    NEVER called by the hermetic test gate (tests stub the model paths). Returns
    the resolved models on success, or ``None`` if a download failed (the caller
    then degrades gracefully — diarization is skipped, the meeting still
    completes). Never raises.

    Idempotent: an already-present file is left untouched (so a bundled model is
    a no-op and repeated calls don't re-download).
    """
    cache = models_cache_dir()
    try:
        cache.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.exception("could not create the sherpa model cache dir %s", cache)
        return None

    for spec in (SEGMENTATION_MODEL, EMBEDDING_MODEL):
        dest = cache / spec.filename
        if dest.is_file():
            continue
        if not _download(spec, dest, timeout=timeout):
            return None

    return resolve_models()


def _download(spec: SherpaModelSpec, dest: Path, *, timeout: float) -> bool:
    """Download ``spec`` to ``dest`` atomically (temp file + replace). Returns
    True on success, False on any failure (never raises). Network-only helper —
    excluded from the gate via :func:`fetch_models`."""
    import tempfile
    import tarfile

    suffix = ".tar.bz2" if spec.archive_member else ".onnx"
    tmp_fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=".tmp-", suffix=suffix)
    os.close(tmp_fd)
    tmp = Path(tmp_name)
    extracted: Path | None = None
    try:
        logger.info("fetching sherpa-onnx diarization model %s", dest.name)
        _download_url_to_file(spec.url, tmp, timeout=timeout)
        if spec.archive_member is None:
            os.replace(tmp, dest)
            return True

        extracted_fd, extracted_name = tempfile.mkstemp(
            dir=str(dest.parent), prefix=".tmp-", suffix=".onnx"
        )
        os.close(extracted_fd)
        extracted = Path(extracted_name)
        with tarfile.open(tmp, "r:bz2") as archive:
            member = archive.extractfile(spec.archive_member)
            if member is None:
                raise FileNotFoundError(spec.archive_member)
            with member, open(extracted, "wb") as fh:
                while True:
                    chunk = member.read(1 << 16)
                    if not chunk:
                        break
                    fh.write(chunk)
        os.replace(extracted, dest)
        return True
    except Exception:  # noqa: BLE001 - any fetch failure degrades; never fatal.
        logger.exception("failed fetching sherpa-onnx model from a non-gated source")
        return False
    finally:
        for partial in (tmp, extracted):
            if partial is not None and partial.exists():
                try:
                    partial.unlink()
                except OSError:
                    pass


def _download_url_to_file(url: str, dest: Path, *, timeout: float) -> None:
    """Download ``url`` to ``dest``."""
    import urllib.request

    with urllib.request.urlopen(url, timeout=timeout) as resp, open(dest, "wb") as fh:
        while True:
            chunk = resp.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
