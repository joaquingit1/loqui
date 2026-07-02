"""SherpaOnnxDiarizer — the no-token, DEFAULT offline DiarizationBackend (PRD-14).

This is the backend that removes the only mandatory token in Loqui. It uses
**sherpa-onnx** (k2-fsa) with two **Apache-2.0** ONNX models — a pyannote-style
segmentation model + a 3D-Speaker CAM++ speaker-embedding model — both fetched
from sherpa-onnx's OWN GitHub releases (no Hugging Face token, no account; see
:mod:`loqui_sidecar.postprocess.sherpa_models`). It auto-clusters speakers (no
need to know the count) and maps the labeled segments to :class:`SpeakerTurn`,
feeding the same PRD-5 ``align()`` path as pyannote.

GRACEFUL DEGRADATION (PRD-14 mirrors PRD-5 AC#4): :meth:`diarize` NEVER raises.
It returns ``DiarizationResult(diarized=False, note=<reason>)`` when

* the ``sherpa_onnx`` package is not importable,
* the ONNX models are not present in the cache dir (and not pre-bundled), or
* the WAV is missing / unreadable,

so the meeting still completes with the live transcript + summary.

``hf_token`` is IRRELEVANT to this backend — it is a no-token path. The argument
is accepted only to satisfy the :class:`DiarizationBackend` protocol; it is
ignored and NEVER logged.

IMPORT-LIGHT: ``sherpa_onnx`` is imported LAZILY inside :meth:`diarize` (never at
module import), and the model paths are resolved via the decoupled
:mod:`sherpa_models` helper — so importing the postprocess package for the
fake-only gate pulls in neither sherpa_onnx nor a model download.

DETERMINISTIC: the produced turns are sorted by ``(start, end, speaker)`` so a
re-run over the same WAV yields the same turn list (idempotent re-diarization).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from typing import Callable, Optional

from . import sherpa_models
from .types import DiarizationResult, SpeakerTurn

logger = logging.getLogger("loqui_sidecar.postprocess.sherpa")

#: The isolated-worker module run as ``python -m`` in a child process (PRD-14
#: crash-safety). A native ONNX crash there becomes a non-zero child exit code.
#: ``sys.executable -m <module>`` needs a real interpreter; PRD-8 must preserve launch isolation.
_WORKER_MODULE = "loqui_sidecar.postprocess.sherpa_worker"

#: Env knob to override the worker timeout (seconds); useful if a very long
#: meeting ever needs more headroom on a slow box.
_WORKER_TIMEOUT_ENV = "LOQUI_DIARIZATION_TIMEOUT_SEC"

#: Default hard ceiling on the isolated diarization run so a hung native call
#: can't wedge the postprocess executor forever. Diarization of even long
#: meetings on this stack is minutes, so a wedged worker should degrade in
#: minutes — not the previous 30 — while still leaving generous headroom.
_WORKER_TIMEOUT_DEFAULT_S = 600.0


def _worker_timeout_s() -> float:
    """Resolve the worker timeout, honoring ``LOQUI_DIARIZATION_TIMEOUT_SEC``.

    A missing / unparseable / non-positive override falls back to the default.
    """
    raw = os.environ.get(_WORKER_TIMEOUT_ENV)
    if raw:
        try:
            value = float(raw)
        except ValueError:
            return _WORKER_TIMEOUT_DEFAULT_S
        if value > 0:
            return value
    return _WORKER_TIMEOUT_DEFAULT_S


#: Short backend identifier surfaced in ``DiarizationResult.backend`` + /health.
SHERPA_BACKEND_NAME = "sherpa-onnx/pyannote-segmentation+campplus"

#: Clustering threshold for auto speaker-count clustering (sherpa FastClustering).
#: Lower = more speakers. 0.5 is sherpa-onnx's documented default for CAM++.
_CLUSTERING_THRESHOLD = 0.5

_DOWNLOAD_FAILURE_NOTE = (
    "could not download the local diarization models; check your connection or bundle them offline"
)
_AUDIO_FORMAT_NOTE = "local diarization needs 16 kHz mono 16-bit audio"


#: A "run the real diarization for these models+wav" callable. Returns a
#: ``WorkerOutcome``. Injectable so the hermetic gate can drive the mapping +
#: degradation logic WITHOUT spawning a child or touching the native runtime; the
#: default (:func:`_run_in_subprocess`) isolates the native run in a child process.
WorkerRunner = Callable[["sherpa_models.ResolvedSherpaModels", str], "WorkerOutcome"]


class WorkerOutcome:
    """The structured result of one isolated diarization attempt.

    Exactly one of ``turns`` (success) / ``note`` (graceful degrade) is meaningful.
    ``note`` is a secret-free, user-facing reason already formatted for the
    ``DiarizationResult``; ``None`` ``note`` + non-None ``turns`` means success.
    """

    __slots__ = ("turns", "note")

    def __init__(self, *, turns: Optional[list[SpeakerTurn]] = None, note: Optional[str] = None):
        self.turns = turns
        self.note = note


class SherpaOnnxDiarizer:
    """No-token local diarizer (sherpa-onnx ONNX).

    The native ONNX run is executed in an ISOLATED CHILD PROCESS (PRD-14
    crash-safety): a C++ access violation in onnxruntime / sherpa-onnx becomes a
    non-zero child exit code the parent converts into a graceful skip, so the
    sidecar NEVER dies and the meeting still completes. Degrades gracefully when
    the runtime, the models, or the WAV are unavailable.

    ``runner`` is injectable so the hermetic gate can exercise the mapping +
    degradation paths in-process (no child, no native libs); production uses the
    default subprocess runner.
    """

    name = SHERPA_BACKEND_NAME

    def __init__(self, runner: Optional[WorkerRunner] = None):
        self._runner: WorkerRunner = runner or _run_in_subprocess

    def diarize(self, wav_path: str, hf_token: Optional[str] = None) -> DiarizationResult:
        # ``hf_token`` is intentionally ignored — this is the NO-TOKEN backend.
        del hf_token

        # Missing WAV -> skip (the parent finalized audio before postProcess, but
        # be defensive). Never raise.
        if not wav_path or not os.path.exists(wav_path):
            return DiarizationResult(
                diarized=False,
                backend=self.name,
                note=f"diarization skipped: audio file not found ({wav_path})",
            )

        models = sherpa_models.resolve_models()
        if models is None:
            if not sherpa_models.model_download_disabled():
                try:
                    models = sherpa_models.fetch_models() or sherpa_models.resolve_models()
                except Exception:  # noqa: BLE001 - download failure degrades, never fatal.
                    logger.exception("sherpa-onnx model fetch failed")
                    models = None
                if models is None:
                    return DiarizationResult(
                        diarized=False,
                        backend=self.name,
                        note=_DOWNLOAD_FAILURE_NOTE,
                    )
            else:
                return DiarizationResult(
                    diarized=False,
                    backend=self.name,
                    note=(
                        "diarization skipped: local diarization models are not available; "
                        "bundle them offline or enable first-run model download."
                    ),
                )

        # Run the native pipeline in an isolated child. The runner NEVER raises —
        # a native crash, a timeout, a missing runtime, and a bad sample rate all
        # come back as a degrade ``note`` (defense-in-depth: still wrap it).
        try:
            outcome = self._runner(models, wav_path)
        except Exception:  # noqa: BLE001 - belt-and-braces; any failure degrades.
            logger.exception("sherpa-onnx isolated diarization failed for %s", wav_path)
            outcome = WorkerOutcome(
                note="diarization skipped: the sherpa-onnx pipeline failed to run."
            )

        if outcome.note is not None:
            return DiarizationResult(diarized=False, backend=self.name, note=outcome.note)

        turns = outcome.turns or []
        return DiarizationResult(turns=turns, diarized=True, backend=self.name, note="")


def _run_in_subprocess(
    models: "sherpa_models.ResolvedSherpaModels",
    wav_path: str,
) -> WorkerOutcome:
    """Run the sherpa-onnx diarization in an ISOLATED CHILD PROCESS (PRD-14
    crash-safety) and parse its outcome.

    A native C++ crash in the child (ABI-mismatched ``onnxruntime.dll``, an ONNX
    access violation, ``abort()``) shows up here as a NON-ZERO ``returncode`` /
    unparseable output — which we convert into a graceful degrade ``note`` so the
    parent sidecar survives. Never raises.

    Uses ``spawn`` semantics via ``python -m`` (works identically on Windows +
    macOS); the only IPC is a JSON payload arg in + a JSON result line out.
    """
    payload = json.dumps(
        {
            "segmentation": models.segmentation,
            "embedding": models.embedding,
            "wav": wav_path,
            "threshold": _CLUSTERING_THRESHOLD,
        }
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-m", _WORKER_MODULE, payload],
            capture_output=True,
            text=True,
            timeout=_worker_timeout_s(),
            # No shell, no inherited stdin (DEVNULL, not the parent's fd 0); the
            # child is fully isolated. This also fails FAST — never a 10-min hang
            # on inherited stdin — if a future frozen-``-m`` regression ever lets
            # the worker boot the server (it blocks on stdin EOF), so it exits at
            # once instead of wedging.
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        logger.warning("sherpa-onnx diarization worker timed out for %s", wav_path)
        return WorkerOutcome(note="diarization skipped: the sherpa-onnx pipeline timed out.")
    except Exception:  # noqa: BLE001 - failing to even spawn the worker degrades.
        logger.exception("could not spawn the sherpa-onnx diarization worker")
        return WorkerOutcome(note="diarization skipped: the sherpa-onnx pipeline failed to run.")

    if proc.returncode != 0:
        # The hallmark of a NATIVE crash: the Python try/except in the worker can't
        # catch a C++ access violation, so the child dies with a non-zero exit
        # (e.g. 139 / 0xC0000005) and we degrade instead of dying ourselves.
        logger.warning(
            "sherpa-onnx diarization worker exited %s for %s (native crash degraded); stderr=%s",
            proc.returncode,
            wav_path,
            (proc.stderr or "").strip()[-500:],
        )
        return WorkerOutcome(
            note="diarization unavailable on this system; the local diarization engine crashed."
        )

    return _parse_worker_output(proc.stdout)


def _parse_worker_output(stdout: str) -> WorkerOutcome:
    """Parse the worker's last stdout line (its JSON result) into a WorkerOutcome.

    Native libraries can print chatter to stdout before the result, so we parse
    the LAST non-empty line. Anything unparseable degrades gracefully.
    """
    last = ""
    for line in (stdout or "").splitlines():
        if line.strip():
            last = line.strip()
    if not last:
        return WorkerOutcome(note="diarization skipped: the sherpa-onnx pipeline failed to run.")

    try:
        data = json.loads(last)
    except (ValueError, TypeError):
        return WorkerOutcome(note="diarization skipped: the sherpa-onnx pipeline failed to run.")

    if not isinstance(data, dict) or not data.get("ok"):
        kind = data.get("kind") if isinstance(data, dict) else None
        if kind == "value":
            return WorkerOutcome(note=f"diarization skipped: {_AUDIO_FORMAT_NOTE}.")
        return WorkerOutcome(note="diarization skipped: the sherpa-onnx pipeline failed to run.")

    raw_turns = data.get("turns") or []
    try:
        turns: list[SpeakerTurn] = [
            SpeakerTurn(
                start=float(t["start"]),
                end=float(t["end"]),
                speaker=f"spk_{int(t['speaker'])}",
            )
            for t in raw_turns
        ]
    except (KeyError, ValueError, TypeError):
        return WorkerOutcome(note="diarization skipped: the sherpa-onnx pipeline failed to run.")
    turns.sort(key=lambda t: (t.start, t.end, t.speaker))
    return WorkerOutcome(turns=turns)


def sherpa_factory() -> SherpaOnnxDiarizer:
    """Construct the no-token sherpa-onnx diarizer (the default backend)."""
    return SherpaOnnxDiarizer()
