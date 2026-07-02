"""High-accuracy OFFLINE re-transcription (PRD-2 two-tier transcription).

The live transcript is produced by a small, streaming model tuned for LOW
LATENCY (greedy, per-window, LocalAgreement-2). After a meeting ends we have the
full recorded audio on disk, so we can do far better: re-decode the WHOLE
``mic.wav`` + ``system.wav`` with a LARGER model, beam search, cross-segment
context, and a single reliable language detection over the entire file. The
result is written as ``transcript.hifi.{jsonl,md}`` — the canonical, accurate
transcript the store serves and diarization aligns to.

This is a BETTER re-transcription of the same audio, NOT an AI edit: it never
touches ``transcript.live.md`` / ``transcript.jsonl`` (those stay byte-identical
as the live record), only the derived hi-fi files via
:mod:`loqui_sidecar.postprocess.writers`.

Robust by construction: missing audio (privacy mode persisted no WAVs), a model
that won't load offline, or a decode crash all degrade to ``produced=False`` —
the meeting still completes on the live transcript. Never raises into the runner.

The decode model is ``LOQUI_HIFI_MODEL_SIZE`` (default ``medium``); the backend
is injectable so the hermetic gate can drive it with a fake.
"""

from __future__ import annotations

import logging
import os
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional, Protocol

from ..providers.transcript import meeting_transcript_path
from ..transcription.types import AUDIO_SAMPLE_RATE
from .writers import write_hifi_transcript

logger = logging.getLogger("loqui_sidecar.postprocess.retranscribe")

#: Env override for the high-accuracy model size. Defaults to ``small`` — it is
#: already cached for the live tier (no extra download), runs ~3× faster than
#: ``medium`` on CPU, and whisper accuracy largely plateaus for typical meeting
#: audio. Set ``medium``/``large-v3`` for maximum accuracy at the cost of speed.
HIFI_MODEL_SIZE_ENV = "LOQUI_HIFI_MODEL_SIZE"
DEFAULT_HIFI_MODEL_SIZE = "small"

#: Env override for the hi-fi beam size. Defaults to ``3`` (a good accuracy/speed
#: balance; ~10-20% faster than 5 with negligible quality loss). ``1`` is greedy.
HIFI_BEAM_SIZE_ENV = "LOQUI_HIFI_BEAM_SIZE"
DEFAULT_HIFI_BEAM_SIZE = 3

#: The capture sources we re-transcribe, in display order (mic first = "You").
_SOURCES = ("mic", "system")


class _SegmentBackend(Protocol):
    """The minimal surface :func:`re_transcribe_meeting` needs from a backend."""

    def transcribe_segments(
        self, pcm: bytes, *, language: Optional[str] = None
    ) -> "tuple[list[tuple[float, float, str]], Optional[str]]": ...


@dataclass
class RetranscribeResult:
    """Outcome of one re-transcription pass.

    ``produced`` is True only when a hi-fi transcript was written. ``failed``
    distinguishes a HARD failure (model unavailable, decode/write crash — worth
    surfacing as a job error) from a benign skip (no recorded audio, no speech)
    where the live transcript simply stands.
    """

    produced: bool = False
    failed: bool = False
    segment_count: int = 0
    language: Optional[str] = None
    sources: list[str] = field(default_factory=list)
    note: str = ""


def resolved_hifi_model_size() -> str:
    value = (os.environ.get(HIFI_MODEL_SIZE_ENV) or "").strip()
    return value or DEFAULT_HIFI_MODEL_SIZE


def resolved_hifi_beam_size() -> int:
    raw = (os.environ.get(HIFI_BEAM_SIZE_ENV) or "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_HIFI_BEAM_SIZE
    except ValueError:
        return DEFAULT_HIFI_BEAM_SIZE


def _audio_dir(meeting_id: str) -> Path:
    """``<dataRoot>/meetings/<id>/audio`` (honors LOQUI_DATA_DIR via the reader)."""
    return meeting_transcript_path(meeting_id, "structured").parent / "audio"


def _read_wav_pcm(path: Path) -> Optional[bytes]:
    """Read a 16 kHz mono ``pcm_s16le`` WAV into raw PCM bytes, or None.

    Returns None when the file is absent/empty. Logs (and still returns the
    frames) when the format is unexpected, so a stray format never silently
    drops audio — faster-whisper expects 16 kHz, so a mismatch is surfaced.
    """
    try:
        if not path.exists() or path.stat().st_size == 0:
            return None
    except OSError:
        return None
    try:
        with wave.open(str(path), "rb") as wf:
            channels = wf.getnchannels()
            rate = wf.getframerate()
            width = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())
    except (wave.Error, OSError, EOFError):
        logger.exception("failed to read WAV %s", path)
        return None
    if not frames:
        return None
    if channels != 1 or rate != AUDIO_SAMPLE_RATE or width != 2:
        logger.warning(
            "unexpected WAV format %s (channels=%s rate=%s width=%s); expected mono/16k/16-bit",
            path,
            channels,
            rate,
            width,
        )
    return frames


def re_transcribe_meeting(
    meeting_id: str,
    *,
    language: Optional[str] = None,
    backend: Optional[_SegmentBackend] = None,
    backend_factory: Optional[Callable[[str, Optional[str]], _SegmentBackend]] = None,
    audio_dir: Optional[Path] = None,
) -> RetranscribeResult:
    """Re-decode a meeting's recorded WAVs with a larger model -> hi-fi transcript.

    ``backend`` (or ``backend_factory(model_size, language)``) is injectable for
    the hermetic gate; the default builds a :class:`FasterWhisperBackend`. Detects
    the language ONCE over the first source with audio, then pins it for the rest
    so both streams agree. Writes ``transcript.hifi.{jsonl,md}`` and returns a
    result; on any failure returns ``produced=False`` (the live transcript stands).
    """
    adir = audio_dir or _audio_dir(meeting_id)

    # Gather the per-source PCM up front so we can skip cleanly when no audio was
    # persisted (privacy mode) before paying to construct/load a large model.
    pcm_by_source: list[tuple[str, bytes]] = []
    for source in _SOURCES:
        pcm = _read_wav_pcm(adir / f"{source}.wav")
        if pcm:
            pcm_by_source.append((source, pcm))
    if not pcm_by_source:
        return RetranscribeResult(note="no recorded audio to re-transcribe")

    model_size = resolved_hifi_model_size()
    if backend is None:
        try:
            if backend_factory is not None:
                backend = backend_factory(model_size, language)
            else:
                from ..transcription.asr_backend import FasterWhisperBackend

                backend = FasterWhisperBackend(
                    model_size=model_size,
                    language=language,
                    # VAD stays ON — it skips silence, which SPEEDS UP the pass on
                    # real meetings (less audio fed to the model), not slows it.
                    vad_filter=True,
                    beam_size=resolved_hifi_beam_size(),
                )
        except Exception:  # noqa: BLE001 - construction failure degrades gracefully.
            logger.exception("failed to construct hi-fi backend for %s", meeting_id)
            return RetranscribeResult(failed=True, note="re-transcription model unavailable")

    records: list[dict] = []
    detected_language = language
    used_sources: list[str] = []
    try:
        for source, pcm in pcm_by_source:
            segments, lang = backend.transcribe_segments(pcm, language=detected_language)
            # Pin the language after the first confident detection so the second
            # stream is decoded with the same language (consistent for one meeting).
            if detected_language is None and lang:
                detected_language = lang
            if segments:
                used_sources.append(source)
            for start, end, text in segments:
                records.append(
                    {
                        "segId": "",  # assigned after the global time-sort below
                        "source": source,
                        "tStart": float(start),
                        "tEnd": float(end),
                        "text": text,
                    }
                )
    except Exception:  # noqa: BLE001 - a decode crash degrades, never fatal.
        logger.exception("hi-fi re-transcription decode failed for %s", meeting_id)
        return RetranscribeResult(failed=True, note="re-transcription decode failed")

    if not records:
        return RetranscribeResult(
            language=detected_language, note="re-transcription produced no speech"
        )

    # Merge both streams into one time-ordered transcript and assign stable ids.
    records.sort(key=lambda r: (r["tStart"], r["tEnd"]))
    for i, r in enumerate(records):
        r["segId"] = f"hifi-{i}"

    try:
        write_hifi_transcript(meeting_id, records)
    except Exception:  # noqa: BLE001 - a write failure leaves the live transcript intact.
        logger.exception("failed to write hi-fi transcript for %s", meeting_id)
        return RetranscribeResult(failed=True, note="failed to write re-transcription")

    return RetranscribeResult(
        produced=True,
        segment_count=len(records),
        language=detected_language,
        sources=used_sources,
    )
