"""Decode an audio/video file to 16 kHz mono pcm_s16le via PyAV (PRD-12).

The SINGLE place that turns a media file into the EXACT PCM format the live
capture path feeds the transcription engine (mono, 16 kHz, signed 16-bit
little-endian) — so an imported file sees the same engine input as a live
meeting (no second/divergent audio format). PyAV (``av``) wraps ffmpeg's
libav*, so any container/codec ffmpeg can read (m4a, mp3, wav, mp4, mov, m4v,
webm, flac, …) decodes here; its :class:`av.AudioResampler` does the resample +
downmix to mono s16.

Output framing mirrors the live DSP frame cadence
(:data:`FRAME_SAMPLES` samples per :class:`~loqui_sidecar.audio_ingest.DecodedFrame`,
20 ms by default) with monotonically increasing ``seq`` and meeting-timeline
``timestamp_ms`` (ms from the start of the file), so the reused streaming
pipeline's VAD/windowing/timestamps behave identically to the live path.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

from ..audio_ingest import (
    AUDIO_CHANNELS,
    AUDIO_SAMPLE_RATE,
    AUDIO_SAMPLE_WIDTH_BYTES,
    DecodedFrame,
)

logger = logging.getLogger("loqui_sidecar.file_import.decode")

#: Source label imported audio is fed under. Single-stream import writes the
#: decoded audio as the ``system`` ("They") stream so the EXISTING alignment
#: labels every speaker ``Speaker N`` (mic would be forced to "You").
IMPORT_SOURCE = "system"

#: Samples per emitted :class:`DecodedFrame` (mirror of the live 20 ms @ 16 kHz
#: DSP frame = 320 samples). Keeping the same frame size means the reused
#: pipeline's windowing/backpressure behaves identically to live capture.
FRAME_SAMPLES = AUDIO_SAMPLE_RATE * 20 // 1000  # 320
_FRAME_BYTES = FRAME_SAMPLES * AUDIO_SAMPLE_WIDTH_BYTES


class DecodeError(RuntimeError):
    """The file could not be opened/decoded (missing file, no audio stream,
    unsupported/corrupt container). Carries a short, user-facing reason."""


def decode_to_pcm16k_mono(path: str | Path) -> bytes:
    """Decode the whole file to one contiguous 16 kHz mono pcm_s16le buffer.

    Convenience wrapper over :func:`iter_decoded_frames` (concatenates the PCM
    of every frame). Raises :class:`DecodeError` when the file has no decodable
    audio. Used by tests/asserts that want the raw PCM; the importer uses the
    frame iterator so it can stream into the pipeline.
    """
    return b"".join(frame.pcm for frame in iter_decoded_frames(path))


def iter_decoded_frames(path: str | Path) -> Iterator[DecodedFrame]:
    """Yield 16 kHz mono pcm_s16le :class:`DecodedFrame`s decoded from ``path``.

    Each frame carries :data:`FRAME_SAMPLES` samples (the last may be shorter),
    ``source = "system"``, a monotonically increasing ``seq`` from 0, and a
    ``timestamp_ms`` = ms from the start of the file. Raises :class:`DecodeError`
    on any open/decode failure or when the file contains no audio stream.
    """
    src = str(path)
    if not Path(src).is_file():
        raise DecodeError(f"file not found: {src}")

    try:
        import av  # lazy: PyAV pulls libav*; only needed on the import path.
    except Exception as exc:  # noqa: BLE001 - surface a clean, user-facing error.
        raise DecodeError(f"PyAV (av) is not available: {exc}") from exc

    try:
        container = av.open(src)
    except Exception as exc:  # noqa: BLE001 - any libav open error.
        raise DecodeError(f"could not open media file: {exc}") from exc

    audio_streams = [s for s in container.streams if s.type == "audio"]
    if not audio_streams:
        container.close()
        raise DecodeError("file has no audio stream")
    stream = audio_streams[0]

    resampler = av.AudioResampler(
        format="s16",
        layout="mono" if AUDIO_CHANNELS == 1 else "stereo",
        rate=AUDIO_SAMPLE_RATE,
    )

    pending = bytearray()
    seq = 0
    samples_emitted = 0

    def _drain(buf: bytearray, *, flush: bool) -> Iterator[DecodedFrame]:
        nonlocal seq, samples_emitted
        # Emit fixed-size frames while we have a full frame buffered; on flush,
        # emit the remaining (possibly short, but 16-bit aligned) tail too.
        while len(buf) >= _FRAME_BYTES or (flush and buf):
            take = (
                _FRAME_BYTES
                if len(buf) >= _FRAME_BYTES
                else (len(buf) - (len(buf) % AUDIO_SAMPLE_WIDTH_BYTES))
            )
            if take <= 0:
                break
            chunk = bytes(buf[:take])
            del buf[:take]
            ts_ms = samples_emitted / AUDIO_SAMPLE_RATE * 1000.0
            samples_emitted += len(chunk) // AUDIO_SAMPLE_WIDTH_BYTES
            yield DecodedFrame(
                source=IMPORT_SOURCE,
                seq=seq,
                timestamp_ms=ts_ms,
                pcm=chunk,
            )
            seq += 1
            if flush and not buf:
                break

    try:
        for av_frame in container.decode(stream):
            for resampled in resampler.resample(av_frame):
                # to_ndarray() -> shape (channels, samples) int16; mono => one row.
                arr = resampled.to_ndarray()
                pending.extend(arr.tobytes())
                yield from _drain(pending, flush=False)
        # Flush the resampler (it may hold a tail), then any buffered remainder.
        try:
            for resampled in resampler.resample(None):
                arr = resampled.to_ndarray()
                pending.extend(arr.tobytes())
        except Exception:  # noqa: BLE001 - flush is best-effort.
            pass
        yield from _drain(pending, flush=True)
    except DecodeError:
        raise
    except Exception as exc:  # noqa: BLE001 - any mid-decode libav error.
        raise DecodeError(f"decode failed: {exc}") from exc
    finally:
        container.close()

    if samples_emitted == 0:
        raise DecodeError("decoded zero audio samples")
