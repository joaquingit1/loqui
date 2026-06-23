"""Hermetic unit tests for the sidecar audio-ingest WAV writer (PRD-1).

These drive :class:`loqui_sidecar.audio_ingest.AudioIngest` directly with
SYNTHETIC PCM (no microphone, no real ``~/Loqui`` — every test pins the data
root to a pytest ``tmp_path``). They assert:

* a synthetic ``audioStart`` + encoded binary frames + ``audioStop`` produces a
  16 kHz / mono / 16-bit WAV with the expected sample count & duration;
* mic and system are written to independent files and never mixed, even when
  their frames are interleaved on the wire;
* the adversarial / out-of-order lifecycle paths degrade safely (never raise):
  a frame before ``audioStart``, a stop with no start, a wrong-magic / short /
  unknown-source frame, an oversize frame, a duplicate/gapped seq.
"""

from __future__ import annotations

import struct
import uuid
import wave
from pathlib import Path

import pytest

from loqui_sidecar import audio_ingest
from loqui_sidecar.audio_ingest import (
    AUDIO_CHANNELS,
    AUDIO_FRAME_HEADER_BYTES,
    AUDIO_FRAME_MAGIC,
    AUDIO_FRAME_SOURCE_BYTE,
    AUDIO_SAMPLE_RATE,
    AUDIO_SAMPLE_WIDTH_BYTES,
    MAX_FRAME_PCM_BYTES,
    AudioIngest,
    decode_frame,
    resolve_data_root,
)

# --- frame encoder (mirror of TS encodeAudioFrame; kept local to the test) ----


def encode_frame(source: str, seq: int, timestamp_ms: float, pcm: bytes) -> bytes:
    """Build a binary frame exactly as ``packages/shared`` ``encodeAudioFrame``."""
    header = bytearray(AUDIO_FRAME_HEADER_BYTES)
    header[0] = AUDIO_FRAME_MAGIC
    header[1] = AUDIO_FRAME_SOURCE_BYTE[source]
    # bytes 2..3 reserved stay 0.
    struct.pack_into("<I", header, 4, seq & 0xFFFFFFFF)
    struct.pack_into("<d", header, 8, timestamp_ms)
    return bytes(header) + pcm


def ramp_pcm(n_samples: int, start: int = 0) -> bytes:
    """``n_samples`` of a mono int16 ramp (deterministic, distinguishable)."""
    return struct.pack("<%dh" % n_samples, *[(start + i) % 1000 for i in range(n_samples)])


def const_pcm(n_samples: int, value: int) -> bytes:
    """``n_samples`` of a constant int16 value (used to prove source isolation)."""
    return struct.pack("<%dh" % n_samples, *([value] * n_samples))


def read_wav(path: Path) -> tuple[wave.Wave_read, bytes]:
    """Open a WAV and return its handle + all PCM frame bytes."""
    w = wave.open(str(path), "rb")
    data = w.readframes(w.getnframes())
    return w, data


@pytest.fixture
def ingest(tmp_path, monkeypatch) -> AudioIngest:
    """A fresh ingest manager with the data root pinned to a temp dir."""
    monkeypatch.setenv("LOQUI_DATA_DIR", str(tmp_path))
    return AudioIngest()


def audio_dir(tmp_path: Path, meeting_id: str) -> Path:
    return tmp_path / "meetings" / meeting_id / "audio"


# --- data-root resolution ------------------------------------------------------


def test_resolve_data_root_honors_env(tmp_path, monkeypatch):
    monkeypatch.setenv("LOQUI_DATA_DIR", str(tmp_path))
    assert resolve_data_root() == tmp_path


def test_resolve_data_root_falls_back_to_home(monkeypatch):
    monkeypatch.delenv("LOQUI_DATA_DIR", raising=False)
    assert resolve_data_root() == Path.home() / "Loqui"


# --- decode_frame round-trip ---------------------------------------------------


def test_decode_frame_round_trips_header_and_pcm():
    pcm = ramp_pcm(8)
    frame = decode_frame(encode_frame("system", 42, 123.5, pcm))
    assert frame.source == "system"
    assert frame.seq == 42
    assert frame.timestamp_ms == pytest.approx(123.5)
    assert frame.pcm == pcm


def test_decode_frame_rejects_short_buffer():
    with pytest.raises(ValueError):
        decode_frame(b"\xa0\x00\x00")


def test_decode_frame_rejects_bad_magic():
    raw = bytearray(encode_frame("mic", 0, 0.0, ramp_pcm(2)))
    raw[0] = 0x00  # corrupt magic
    with pytest.raises(ValueError):
        decode_frame(bytes(raw))


def test_decode_frame_rejects_unknown_source():
    raw = bytearray(encode_frame("mic", 0, 0.0, ramp_pcm(2)))
    raw[1] = 0x07  # unknown source byte
    with pytest.raises(ValueError):
        decode_frame(bytes(raw))


# --- happy path: one source ----------------------------------------------------


def test_single_source_writes_valid_16k_mono_wav(ingest, tmp_path):
    meeting_id = str(uuid.uuid4())
    samples_per_frame = audio_ingest.AUDIO_SAMPLE_RATE // 50  # 20 ms = 320 samples
    n_frames = 5

    ingest.handle_audio_start(meeting_id, "mic")
    total_samples = 0
    for seq in range(n_frames):
        pcm = ramp_pcm(samples_per_frame, start=seq * samples_per_frame)
        ingest.handle_binary_frame(encode_frame("mic", seq, seq * 20.0, pcm))
        total_samples += samples_per_frame
    ingest.handle_audio_stop(meeting_id, "mic")

    wav_path = audio_dir(tmp_path, meeting_id) / "mic.wav"
    assert wav_path.exists()

    w, data = read_wav(wav_path)
    try:
        assert w.getframerate() == AUDIO_SAMPLE_RATE
        assert w.getnchannels() == AUDIO_CHANNELS
        assert w.getsampwidth() == AUDIO_SAMPLE_WIDTH_BYTES
        assert w.getnframes() == total_samples
        # Duration: total_samples / 16000 == n_frames * 20 ms.
        assert w.getnframes() / w.getframerate() == pytest.approx(n_frames * 0.020)
        assert len(data) == total_samples * AUDIO_SAMPLE_WIDTH_BYTES
    finally:
        w.close()


def test_riff_sizes_are_finalized_on_stop(ingest, tmp_path):
    """A correctly finalized WAV has RIFF/data chunk sizes matching the bytes."""
    meeting_id = str(uuid.uuid4())
    pcm = ramp_pcm(320)
    ingest.handle_audio_start(meeting_id, "mic")
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, pcm))
    ingest.handle_audio_stop(meeting_id, "mic")

    wav_path = audio_dir(tmp_path, meeting_id) / "mic.wav"
    raw = wav_path.read_bytes()
    assert raw[0:4] == b"RIFF"
    assert raw[8:12] == b"WAVE"
    riff_size = struct.unpack_from("<I", raw, 4)[0]
    # RIFF chunk size = total file size - 8 (the "RIFF" + size fields).
    assert riff_size == len(raw) - 8


# --- source isolation: mic vs system never mix --------------------------------


def test_mic_and_system_are_independent_files_and_unmixed(ingest, tmp_path):
    meeting_id = str(uuid.uuid4())
    n = 320
    mic_pcm = const_pcm(n, 100)  # mic carries the constant +100
    sys_pcm = const_pcm(n, -100)  # system carries the constant -100

    ingest.handle_audio_start(meeting_id, "mic")
    ingest.handle_audio_start(meeting_id, "system")
    # Interleave the two sources on the wire — they must stay separate.
    for seq in range(4):
        ingest.handle_binary_frame(encode_frame("mic", seq, seq * 20.0, mic_pcm))
        ingest.handle_binary_frame(encode_frame("system", seq, seq * 20.0, sys_pcm))
    ingest.handle_audio_stop(meeting_id, "mic")
    ingest.handle_audio_stop(meeting_id, "system")

    mic_path = audio_dir(tmp_path, meeting_id) / "mic.wav"
    sys_path = audio_dir(tmp_path, meeting_id) / "system.wav"
    assert mic_path.exists() and sys_path.exists()

    wm, mic_data = read_wav(mic_path)
    ws, sys_data = read_wav(sys_path)
    try:
        assert wm.getnframes() == 4 * n
        assert ws.getnframes() == 4 * n
        # Each file holds ONLY its own constant — no cross-contamination.
        assert set(struct.unpack("<%dh" % (4 * n), mic_data)) == {100}
        assert set(struct.unpack("<%dh" % (4 * n), sys_data)) == {-100}
    finally:
        wm.close()
        ws.close()


def test_two_meetings_write_to_separate_dirs(ingest, tmp_path):
    m1, m2 = str(uuid.uuid4()), str(uuid.uuid4())
    ingest.handle_audio_start(m1, "mic")
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, ramp_pcm(160)))
    ingest.handle_audio_stop(m1, "mic")

    ingest.handle_audio_start(m2, "mic")
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, ramp_pcm(320)))
    ingest.handle_audio_stop(m2, "mic")

    w1, _ = read_wav(audio_dir(tmp_path, m1) / "mic.wav")
    w2, _ = read_wav(audio_dir(tmp_path, m2) / "mic.wav")
    try:
        assert w1.getnframes() == 160
        assert w2.getnframes() == 320
    finally:
        w1.close()
        w2.close()


# --- adversarial / out-of-order lifecycle (must never raise) ------------------


def test_frame_before_audiostart_is_dropped(ingest, tmp_path):
    meeting_id = str(uuid.uuid4())
    # No audioStart for mic: this frame has nowhere to go.
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, ramp_pcm(320)))
    assert ingest.frames_seen == 1
    assert ingest.frames_dropped == 1
    assert ingest.frames_written == 0
    # No file created.
    assert not (audio_dir(tmp_path, meeting_id) / "mic.wav").exists()


def test_audiostop_with_no_start_is_noop(ingest):
    # Must not raise and must not create anything.
    ingest.handle_audio_stop(str(uuid.uuid4()), "mic")


def test_wrong_magic_frame_is_rejected(ingest, tmp_path):
    meeting_id = str(uuid.uuid4())
    ingest.handle_audio_start(meeting_id, "mic")
    raw = bytearray(encode_frame("mic", 0, 0.0, ramp_pcm(320)))
    raw[0] = 0x00  # bad magic
    ingest.handle_binary_frame(bytes(raw))
    ingest.handle_audio_stop(meeting_id, "mic")

    assert ingest.frames_dropped == 1
    assert ingest.frames_written == 0
    # The WAV was opened (start) but holds zero frames (the bad frame dropped).
    w, _ = read_wav(audio_dir(tmp_path, meeting_id) / "mic.wav")
    try:
        assert w.getnframes() == 0
    finally:
        w.close()


def test_unknown_source_byte_frame_is_rejected(ingest):
    meeting_id = str(uuid.uuid4())
    ingest.handle_audio_start(meeting_id, "mic")
    raw = bytearray(encode_frame("mic", 0, 0.0, ramp_pcm(320)))
    raw[1] = 0x09  # unknown source
    ingest.handle_binary_frame(bytes(raw))
    assert ingest.frames_dropped == 1
    assert ingest.frames_written == 0


def test_short_frame_is_rejected(ingest):
    ingest.handle_binary_frame(b"\xa0\x00")  # shorter than the 16-byte header
    assert ingest.frames_dropped == 1


def test_oversize_frame_is_dropped(ingest):
    meeting_id = str(uuid.uuid4())
    ingest.handle_audio_start(meeting_id, "mic")
    big_pcm = b"\x00" * (MAX_FRAME_PCM_BYTES + 2)
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, big_pcm))
    ingest.handle_audio_stop(meeting_id, "mic")
    assert ingest.frames_dropped == 1
    assert ingest.frames_written == 0


def test_out_of_order_and_gapped_seq_still_written(ingest, tmp_path):
    """seq anomalies are advisory: the payload is still written, never reordered."""
    meeting_id = str(uuid.uuid4())
    ingest.handle_audio_start(meeting_id, "mic")
    # seq 0, then jump to 5 (gap), then 2 (out of order), then 5 again (dup).
    for seq in (0, 5, 2, 5):
        ingest.handle_binary_frame(encode_frame("mic", seq, 0.0, ramp_pcm(16)))
    ingest.handle_audio_stop(meeting_id, "mic")

    w, _ = read_wav(audio_dir(tmp_path, meeting_id) / "mic.wav")
    try:
        assert w.getnframes() == 4 * 16  # all four frames written despite seq mess
    finally:
        w.close()


def test_odd_length_pcm_drops_ragged_trailing_byte(ingest, tmp_path):
    """A non-16-bit-aligned payload keeps the WAV well-formed (drops 1 byte)."""
    meeting_id = str(uuid.uuid4())
    ingest.handle_audio_start(meeting_id, "mic")
    # 5 bytes of PCM = 2 whole int16 samples + 1 ragged byte.
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, b"\x01\x02\x03\x04\x05"))
    ingest.handle_audio_stop(meeting_id, "mic")

    w, data = read_wav(audio_dir(tmp_path, meeting_id) / "mic.wav")
    try:
        assert w.getnframes() == 2  # ragged 5th byte dropped
        assert len(data) == 4
    finally:
        w.close()


def test_restart_same_source_finalizes_previous_wav(ingest, tmp_path):
    """A second audioStart for an open source re-opens (no leaked handle)."""
    meeting_id = str(uuid.uuid4())
    ingest.handle_audio_start(meeting_id, "mic")
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, ramp_pcm(320)))
    # Re-start before stop: previous writer is finalized + truncated-reopened.
    ingest.handle_audio_start(meeting_id, "mic")
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, ramp_pcm(160)))
    ingest.handle_audio_stop(meeting_id, "mic")

    w, _ = read_wav(audio_dir(tmp_path, meeting_id) / "mic.wav")
    try:
        # The reopened file holds only the post-restart frame.
        assert w.getnframes() == 160
    finally:
        w.close()


def test_unknown_source_in_lifecycle_is_ignored(ingest):
    # Defense in depth: schema constrains source, but the seam must not crash.
    ingest.handle_audio_start(str(uuid.uuid4()), "speaker")  # not mic/system
    ingest.handle_audio_stop(str(uuid.uuid4()), "speaker")


# --- pluggable consumer hook (PRD-2 seam) -------------------------------------


def test_extra_consumer_receives_decoded_frames(ingest):
    """A subscribed consumer sees on_start/on_frame/on_stop alongside the WAV."""
    events: list[tuple[str, str, str]] = []

    class Recorder:
        def on_start(self, meeting_id, source):
            events.append(("start", meeting_id, source))

        def on_frame(self, meeting_id, source, frame):
            events.append(("frame", meeting_id, source))
            assert frame.pcm  # decoded payload is delivered, not raw bytes

        def on_stop(self, meeting_id, source):
            events.append(("stop", meeting_id, source))

    meeting_id = str(uuid.uuid4())
    ingest.add_consumer(Recorder())
    ingest.handle_audio_start(meeting_id, "system")
    ingest.handle_binary_frame(encode_frame("system", 0, 0.0, ramp_pcm(32)))
    ingest.handle_audio_stop(meeting_id, "system")

    assert events == [
        ("start", meeting_id, "system"),
        ("frame", meeting_id, "system"),
        ("stop", meeting_id, "system"),
    ]


def test_raising_consumer_does_not_break_wav_writer(ingest, tmp_path):
    """A misbehaving consumer must not stop the WAV being written."""

    class Boom:
        def on_start(self, *a):
            raise RuntimeError("boom")

        def on_frame(self, *a):
            raise RuntimeError("boom")

        def on_stop(self, *a):
            raise RuntimeError("boom")

    meeting_id = str(uuid.uuid4())
    ingest.add_consumer(Boom())
    ingest.handle_audio_start(meeting_id, "mic")
    ingest.handle_binary_frame(encode_frame("mic", 0, 0.0, ramp_pcm(320)))
    ingest.handle_audio_stop(meeting_id, "mic")

    w, _ = read_wav(audio_dir(tmp_path, meeting_id) / "mic.wav")
    try:
        assert w.getnframes() == 320  # WAV unaffected by the raising consumer
    finally:
        w.close()


def test_default_ingest_returns_real_writer():
    assert isinstance(audio_ingest.default_ingest(), AudioIngest)
