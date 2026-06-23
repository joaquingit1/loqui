"""Audio ingest entry point (PRD-1 implementation).

This module is the SINGLE seam the WS layer (:mod:`loqui_sidecar.app`) calls
when audio control frames and binary PCM frames arrive. PRD-1's
``sidecar-audio-ingest`` Build unit replaces Foundation's no-op default with
the real per-source PCM -> WAV pipeline behind the same interface.

Wire contract (must not drift from ``@loqui/shared`` / ``packages/shared``):

* Binary WS frame = 16-byte little-endian header + pcm_s16le payload::

    byte 0      magic = 0xA0
    byte 1      source (0 = mic, 1 = system)
    bytes 2..3  reserved (0)
    bytes 4..7  uint32 sequence number (per-source, from 0)
    bytes 8..15 float64 captureTimestampMs (ms since meeting start)
    bytes 16..  pcm_s16le, mono, 16 kHz

* Control frames ``audioStart`` / ``audioStop`` arrive as validated JSON
  notifications and call :func:`AudioIngest.handle_audio_start` /
  :func:`AudioIngest.handle_audio_stop` BEFORE/after the binary frames for
  that source.

On-disk output (one WAV per source, 16 kHz mono pcm_s16le), under the
per-meeting audio dir resolved from the data root (``LOQUI_DATA_DIR`` env or
``~/Loqui``)::

    <dataRoot>/meetings/<meeting_id>/audio/mic.wav     (source == "mic")
    <dataRoot>/meetings/<meeting_id>/audio/system.wav  (source == "system")

The two sources are independent end-to-end and never mixed: each
``(meeting_id, source)`` has its own writer + file, and binary frames route
solely by the decoded ``source`` byte to that source's active writer.

Robustness contract (enforced here, relied on by :mod:`loqui_sidecar.app`):

* No method ever raises. The WS receive loop guards them anyway, but it drops
  audio on error rather than tearing down the control channel — so a bad frame
  or a disk error must degrade to a logged drop, not an exception.
* Out-of-order lifecycle is tolerated: a binary frame before its
  ``audioStart`` is dropped (logged once); a duplicate / unmatched
  ``audioStop`` is a no-op; a second ``audioStart`` for an already-open source
  finalizes the previous writer first.
* Sequence numbers are advisory: gaps and out-of-order ``seq`` are logged but
  the payload is still written (we never reorder a streamed WAV).
"""

from __future__ import annotations

import logging
import os
import struct
import threading
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Protocol

logger = logging.getLogger("loqui_sidecar.audio_ingest")

# --- Wire-format constants (mirror of packages/shared/src/audio.ts) -----------

#: Fixed binary frame header size (bytes). Mirror of AUDIO_FRAME_HEADER_BYTES.
AUDIO_FRAME_HEADER_BYTES = 16
#: First header byte. Mirror of AUDIO_FRAME_MAGIC.
AUDIO_FRAME_MAGIC = 0xA0
#: source byte -> source name. Mirror of AUDIO_FRAME_SOURCE_BY_BYTE.
AUDIO_FRAME_SOURCE_BY_BYTE: dict[int, str] = {0: "mic", 1: "system"}
#: source name -> source byte. Inverse of the above.
AUDIO_FRAME_SOURCE_BYTE: dict[str, int] = {"mic": 0, "system": 1}

# Byte offsets inside the 16-byte little-endian header (mirror AUDIO_FRAME_OFFSET).
_OFF_MAGIC = 0
_OFF_SOURCE = 1
_OFF_SEQ = 4
_OFF_TIMESTAMP = 8

# --- Canonical capture format (mirror of packages/shared constants) -----------

AUDIO_SAMPLE_RATE = 16000
AUDIO_CHANNELS = 1
#: pcm_s16le -> 2 bytes per sample.
AUDIO_SAMPLE_WIDTH_BYTES = 2

#: Data-root layout (mirror of packages/shared/src/constants.ts).
DATA_DIR_ENV = "LOQUI_DATA_DIR"
DEFAULT_DATA_DIR_NAME = "Loqui"
MEETINGS_DIR_NAME = "meetings"
MEETING_AUDIO_DIR_NAME = "audio"
AUDIO_WAV_FILENAME: dict[str, str] = {"mic": "mic.wav", "system": "system.wav"}

#: A sane ceiling on a single binary frame's PCM payload. Frames much larger
#: than a few seconds of 16 kHz mono audio almost certainly indicate a
#: malformed/hostile frame; we log + drop rather than allocate/append them. 16
#: MiB ~= 8.7 min of 16 kHz mono pcm_s16le, far beyond the 20 ms DSP default.
MAX_FRAME_PCM_BYTES = 16 * 1024 * 1024


def resolve_data_root() -> Path:
    """Resolve the data root, honoring ``LOQUI_DATA_DIR`` (falls back to ~/Loqui).

    Read every call (not cached) so a test that sets the env var per-process is
    always honored, matching the TS contract that *every* path resolution reads
    the env.
    """
    override = os.environ.get(DATA_DIR_ENV)
    if override:
        return Path(override)
    return Path.home() / DEFAULT_DATA_DIR_NAME


def meeting_audio_dir(meeting_id: str, data_root: Optional[Path] = None) -> Path:
    """``<dataRoot>/meetings/<meeting_id>/audio/`` (not created here)."""
    root = data_root if data_root is not None else resolve_data_root()
    return root / MEETINGS_DIR_NAME / meeting_id / MEETING_AUDIO_DIR_NAME


@dataclass(frozen=True)
class DecodedFrame:
    """A decoded binary audio frame: header fields + its pcm_s16le payload."""

    source: str
    seq: int
    timestamp_ms: float
    pcm: bytes


def decode_frame(raw: bytes) -> DecodedFrame:
    """Decode one binary audio frame (mirror of TS ``decodeAudioFrame``).

    Raises :class:`ValueError` on a short buffer, bad magic, or unknown source
    byte. The PCM payload is returned as ``bytes`` (a copy of the tail) so the
    caller can retain it past the frame's lifetime.
    """
    if len(raw) < AUDIO_FRAME_HEADER_BYTES:
        raise ValueError(f"audio frame too short: {len(raw)} < {AUDIO_FRAME_HEADER_BYTES}")
    magic = raw[_OFF_MAGIC]
    if magic != AUDIO_FRAME_MAGIC:
        raise ValueError(f"bad audio frame magic: 0x{magic:02x}")
    source_byte = raw[_OFF_SOURCE]
    source = AUDIO_FRAME_SOURCE_BY_BYTE.get(source_byte)
    if source is None:
        raise ValueError(f"unknown audio frame source byte: {source_byte}")
    # Little-endian, matching DataView setUint32/setFloat64(..., true) on the TS side.
    (seq,) = struct.unpack_from("<I", raw, _OFF_SEQ)
    (timestamp_ms,) = struct.unpack_from("<d", raw, _OFF_TIMESTAMP)
    pcm = bytes(raw[AUDIO_FRAME_HEADER_BYTES:])
    return DecodedFrame(source=source, seq=seq, timestamp_ms=timestamp_ms, pcm=pcm)


class FrameConsumer(Protocol):
    """A pluggable sink for decoded per-frame PCM bytes.

    PRD-1 ships the :class:`WavWriterConsumer`; PRD-2 transcription subscribes
    its own consumer to the same decoded stream without touching the ingest
    manager. Consumers MUST NOT raise out of these methods — the manager guards
    them, but a raising consumer would drop audio for that frame.
    """

    def on_start(self, meeting_id: str, source: str) -> None:
        """A new ``(meeting_id, source)`` stream opened (audioStart)."""

    def on_frame(self, meeting_id: str, source: str, frame: DecodedFrame) -> None:
        """One decoded frame for the active ``(meeting_id, source)`` stream."""

    def on_stop(self, meeting_id: str, source: str) -> None:
        """The ``(meeting_id, source)`` stream is finalizing (audioStop)."""


class _WavStream:
    """One open 16 kHz mono pcm_s16le WAV writer for a ``(meeting_id, source)``.

    Wraps stdlib :mod:`wave`, which keeps RIFF chunk sizes correct as long as we
    ``close()`` it (it back-patches the sizes on close).
    """

    def __init__(self, meeting_id: str, source: str, path: Path) -> None:
        self.meeting_id = meeting_id
        self.source = source
        self.path = path
        self.frames_written = 0
        self.samples_written = 0
        self.bytes_written = 0
        #: Last seq we saw, for gap/out-of-order detection (advisory only).
        self._last_seq: Optional[int] = None
        path.parent.mkdir(parents=True, exist_ok=True)
        self._wav = wave.open(str(path), "wb")
        self._wav.setnchannels(AUDIO_CHANNELS)
        self._wav.setsampwidth(AUDIO_SAMPLE_WIDTH_BYTES)
        self._wav.setframerate(AUDIO_SAMPLE_RATE)

    def append(self, frame: DecodedFrame) -> None:
        """Append one frame's PCM payload; log (don't reject) seq anomalies."""
        self._check_seq(frame.seq)
        pcm = frame.pcm
        # pcm_s16le frame size = 2 bytes/sample (mono). A ragged trailing byte
        # would desync the WAV's sample frames; drop it (log) so the file stays
        # well-formed rather than corrupting subsequent samples.
        usable = len(pcm) - (len(pcm) % AUDIO_SAMPLE_WIDTH_BYTES)
        if usable != len(pcm):
            logger.warning(
                "audio %s/%s: dropping %d trailing byte(s); pcm not 16-bit aligned",
                self.meeting_id,
                self.source,
                len(pcm) - usable,
            )
            pcm = pcm[:usable]
        if not pcm:
            return
        self._wav.writeframes(pcm)
        self.frames_written += 1
        self.bytes_written += len(pcm)
        self.samples_written += len(pcm) // AUDIO_SAMPLE_WIDTH_BYTES

    def _check_seq(self, seq: int) -> None:
        prev = self._last_seq
        if prev is not None:
            if seq == prev:
                logger.warning("audio %s/%s: duplicate seq %d", self.meeting_id, self.source, seq)
            elif seq < prev:
                logger.warning(
                    "audio %s/%s: out-of-order seq %d after %d",
                    self.meeting_id,
                    self.source,
                    seq,
                    prev,
                )
            elif seq > prev + 1:
                logger.warning(
                    "audio %s/%s: gap of %d frame(s) before seq %d",
                    self.meeting_id,
                    self.source,
                    seq - prev - 1,
                    seq,
                )
        self._last_seq = seq

    def close(self) -> None:
        """Finalize the WAV (back-patch RIFF sizes) and close the file."""
        try:
            self._wav.close()
        except Exception:  # noqa: BLE001 - close must never propagate.
            logger.exception("audio %s/%s: error closing WAV", self.meeting_id, self.source)


class WavWriterConsumer:
    """Default consumer: writes one 16 kHz mono pcm_s16le WAV per source.

    Keyed by ``(meeting_id, source)``; mic and system never share a stream.
    """

    def __init__(self, data_root: Optional[Path] = None) -> None:
        #: Pinned data root if provided; otherwise resolved per stream from env.
        self._data_root = data_root
        self._streams: dict[tuple[str, str], _WavStream] = {}

    def _path_for(self, meeting_id: str, source: str) -> Path:
        return meeting_audio_dir(meeting_id, self._data_root) / AUDIO_WAV_FILENAME[source]

    def on_start(self, meeting_id: str, source: str) -> None:
        key = (meeting_id, source)
        existing = self._streams.pop(key, None)
        if existing is not None:
            # Re-start of an already-open stream: finalize the old WAV first so
            # we never leak a file handle, then truncate-reopen at the new path.
            logger.warning(
                "audio %s/%s: audioStart while already open; re-opening",
                meeting_id,
                source,
            )
            existing.close()
        path = self._path_for(meeting_id, source)
        self._streams[key] = _WavStream(meeting_id, source, path)

    def on_frame(self, meeting_id: str, source: str, frame: DecodedFrame) -> None:
        stream = self._streams.get((meeting_id, source))
        if stream is None:
            return  # already handled (dropped + logged) by the manager.
        stream.append(frame)

    def on_stop(self, meeting_id: str, source: str) -> None:
        stream = self._streams.pop((meeting_id, source), None)
        if stream is None:
            logger.warning(
                "audio %s/%s: audioStop with no open stream (ignored)",
                meeting_id,
                source,
            )
            return
        stream.close()

    def close_all(self) -> None:
        """Finalize any still-open streams (process shutdown / safety net)."""
        for stream in self._streams.values():
            stream.close()
        self._streams.clear()


class AudioIngest:
    """Per-launch audio-ingest manager keyed by ``(meeting_id, source)``.

    One instance lives on the server :class:`~loqui_sidecar.app.AppState` for
    the process lifetime and is handed every audio control + binary frame.

    Binary frames carry only their ``source`` in the header (no meeting id), so
    the manager tracks the *active meeting per source*: ``audioStart`` binds a
    source to a meeting, every subsequent binary frame for that source routes to
    it, and ``audioStop`` unbinds it. mic and system have independent slots, so
    interleaving the two sources keeps each stream's data in its own file.

    Thread-safe (a lock guards the active-stream map + consumer dispatch) since
    the WS receive loop and any future producer could touch it concurrently.

    None of the public methods raise — they log and drop on any error so the WS
    control channel is never torn down by audio.
    """

    def __init__(self, consumers: Optional[list[FrameConsumer]] = None) -> None:
        #: Diagnostic counters (kept for parity with the no-op default + tests).
        self.frames_seen = 0
        self.frames_written = 0
        self.frames_dropped = 0
        #: Active meeting id per source: ``{"mic": <id>, "system": <id>}``.
        self._active: dict[str, str] = {}
        self._lock = threading.Lock()
        #: The WAV writer is always present; extra consumers (e.g. PRD-2) append.
        self._wav = WavWriterConsumer()
        self._consumers: list[FrameConsumer] = [self._wav]
        if consumers:
            self._consumers.extend(consumers)

    # -- consumer registration ------------------------------------------------

    def add_consumer(self, consumer: FrameConsumer) -> None:
        """Subscribe an extra :class:`FrameConsumer` (e.g. PRD-2 transcription).

        Receives every subsequent ``on_start`` / ``on_frame`` / ``on_stop``
        alongside the built-in WAV writer.
        """
        with self._lock:
            self._consumers.append(consumer)

    @property
    def wav(self) -> WavWriterConsumer:
        """The built-in WAV-writer consumer (exposed for tests / introspection)."""
        return self._wav

    def wav_path(self, meeting_id: str, source: str) -> Path:
        """Resolve the on-disk WAV path for ``(meeting_id, source)``."""
        return self._wav._path_for(meeting_id, source)

    # -- lifecycle hooks (called from loqui_sidecar.app) ----------------------

    def handle_audio_start(self, meeting_id: str, source: str) -> None:
        """Open the per-source WAV writer for ``(meeting_id, source)``.

        Called when a validated ``audioStart`` notification arrives. ``source``
        is one of ``"mic"`` / ``"system"``. Never raises.
        """
        try:
            if source not in AUDIO_FRAME_SOURCE_BYTE:
                logger.warning("audioStart: unknown source %r (ignored)", source)
                return
            with self._lock:
                self._active[source] = meeting_id
                consumers = list(self._consumers)
            for consumer in consumers:
                self._safe(consumer.on_start, meeting_id, source)
        except Exception:  # noqa: BLE001 - ingest must never raise.
            logger.exception("audioStart failed for %s/%s", meeting_id, source)

    def handle_audio_stop(self, meeting_id: str, source: str) -> None:
        """Finalize + close the per-source WAV writer. Never raises.

        Tolerates a stop with no matching start (logged no-op) and a stop whose
        ``meeting_id`` differs from the active one (still finalizes that
        source's stream — best effort).
        """
        try:
            if source not in AUDIO_FRAME_SOURCE_BYTE:
                logger.warning("audioStop: unknown source %r (ignored)", source)
                return
            with self._lock:
                active = self._active.get(source)
                if active is not None and active == meeting_id:
                    self._active.pop(source, None)
                consumers = list(self._consumers)
            for consumer in consumers:
                self._safe(consumer.on_stop, meeting_id, source)
        except Exception:  # noqa: BLE001 - ingest must never raise.
            logger.exception("audioStop failed for %s/%s", meeting_id, source)

    def handle_binary_frame(self, raw: bytes) -> None:
        """Ingest one raw binary audio frame (header + pcm_s16le payload).

        Decodes the 16-byte header, routes the payload to the active stream for
        its ``source``, and fans it out to every consumer. Never raises:

        * a malformed frame (short / bad magic / unknown source) is dropped;
        * a frame before its ``audioStart`` (no active meeting for that source)
          is dropped + logged;
        * an oversize payload is dropped + logged.
        """
        self.frames_seen += 1
        try:
            if len(raw) - AUDIO_FRAME_HEADER_BYTES > MAX_FRAME_PCM_BYTES:
                logger.warning(
                    "audio frame too large: %d PCM bytes (max %d); dropped",
                    len(raw) - AUDIO_FRAME_HEADER_BYTES,
                    MAX_FRAME_PCM_BYTES,
                )
                self.frames_dropped += 1
                return
            try:
                frame = decode_frame(raw)
            except ValueError as exc:
                logger.warning("dropping malformed audio frame: %s", exc)
                self.frames_dropped += 1
                return

            with self._lock:
                meeting_id = self._active.get(frame.source)
                consumers = list(self._consumers)
            if meeting_id is None:
                logger.warning(
                    "audio frame for source %r before audioStart; dropped",
                    frame.source,
                )
                self.frames_dropped += 1
                return

            for consumer in consumers:
                self._safe(consumer.on_frame, meeting_id, frame.source, frame)
            self.frames_written += 1
        except Exception:  # noqa: BLE001 - ingest must never raise.
            logger.exception("handle_binary_frame failed")
            self.frames_dropped += 1

    def close(self) -> None:
        """Finalize all open streams (safety net for process shutdown)."""
        with self._lock:
            self._active.clear()
        self._wav.close_all()

    @staticmethod
    def _safe(fn: Callable[..., None], *args: object) -> None:
        """Invoke a consumer callback, swallowing+logging any exception."""
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - one consumer must not break the rest.
            logger.exception("audio consumer %r raised", getattr(fn, "__qualname__", fn))


def default_ingest() -> AudioIngest:
    """Construct the default ingest manager (real WAV writer; replaces no-op)."""
    return AudioIngest()
