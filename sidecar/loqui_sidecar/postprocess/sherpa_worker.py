"""Isolated sherpa-onnx diarization WORKER (PRD-14 crash-safety).

CRASH-SAFETY INVARIANT (PRD-14): the native sherpa-onnx / onnxruntime backend can
HARD-CRASH the process — a C++ access violation / ``abort()`` (e.g. an ABI-mismatched
``onnxruntime.dll``, exit 139 / 0xC0000005) that a Python ``try/except`` CANNOT catch.
If that ran in the sidecar's own process it would kill the whole sidecar and the
meeting would never finalize. So the real ONNX run is executed HERE, in a SEPARATE
child process spawned by :mod:`sherpa_backend`. A native crash then becomes a
non-zero EXIT CODE the parent observes and converts into a graceful
``DiarizationResult(diarized=False, …)`` — the sidecar survives, the meeting still
completes.

Contract (kept dead simple so it survives ``spawn`` on Windows + macOS — no
pickling of app objects, no shared state):

* INPUT: a single JSON arg (argv[1]) ``{"segmentation","embedding","wav","threshold"}``.
* OUTPUT (stdout, last line): ``{"ok":true,"turns":[{"start","end","speaker"},…]}``
  on success, or ``{"ok":false,"error":"...","kind":"value"|"runtime"}`` on a
  caught Python-level failure. A NATIVE crash prints nothing parseable and exits
  non-zero — the parent treats *any* non-success the same way: degrade.

This module imports ``sherpa_onnx`` (the heavy/native dep) ONLY when run as the
worker entrypoint, so importing the postprocess package never pulls it in.
"""

from __future__ import annotations

import json
import sys
import wave


def _read_wave(wav_path: str):
    """Read a mono 16-bit PCM WAV into ``(float32 samples in [-1, 1], rate)``.

    Mirrors :func:`sherpa_backend._read_wave` (kept local so the worker has no
    intra-package import surface beyond the stdlib + numpy).
    """
    import numpy as np

    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise ValueError(f"expected 16-bit PCM WAV for diarization, got {sampwidth * 8}-bit")

    pcm = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        pcm = pcm.reshape(-1, n_channels).mean(axis=1)
    return pcm, rate


def run(payload: dict) -> dict:
    """Run the real sherpa-onnx diarization for ``payload`` and return the result
    dict (``{"ok":True,"turns":[…]}`` or ``{"ok":False,...}``). Never lets a
    *Python-level* exception escape; a NATIVE crash, by definition, cannot be
    caught here and instead crashes the child (the parent handles that)."""
    import sherpa_onnx  # type: ignore[import-not-found]

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=payload["segmentation"]
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=payload["embedding"]),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=-1,
            threshold=float(payload["threshold"]),
        ),
    )

    sd = sherpa_onnx.OfflineSpeakerDiarization(config)

    samples, sample_rate = _read_wave(payload["wav"])
    if sd.sample_rate != sample_rate:
        return {
            "ok": False,
            "kind": "value",
            "error": f"expected {sd.sample_rate} Hz audio for diarization, got {sample_rate} Hz",
        }

    result = sd.process(samples)
    segments = result.sort_by_start_time()
    turns = [
        {"start": float(seg.start), "end": float(seg.end), "speaker": int(seg.speaker)}
        for seg in segments
    ]
    return {"ok": True, "turns": turns}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"ok": False, "kind": "runtime", "error": "missing payload"}))
        return 2
    try:
        payload = json.loads(argv[1])
    except (ValueError, TypeError) as exc:
        print(json.dumps({"ok": False, "kind": "runtime", "error": f"bad payload: {exc}"}))
        return 2

    try:
        out = run(payload)
    except ValueError as exc:
        out = {"ok": False, "kind": "value", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - any Python-level failure -> structured degrade.
        out = {"ok": False, "kind": "runtime", "error": str(exc)}

    # The result is the LAST stdout line so native-lib chatter on prior lines is
    # ignored by the parent's last-line JSON parse.
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
