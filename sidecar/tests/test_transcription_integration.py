"""End-to-end (in-process) PRD-2 integration: AudioIngest -> TranscriptionManager
-> real StreamingTranscriptionPipeline (VAD + LocalAgreement-2) -> emitted
TranscriptSegments, driven by the deterministic streaming FAKE backend.

Hermetic: no model, no network, no devices, no real ~/Loqui. This is the in-proc
analog of scripts/smoke-transcription.mjs — it proves the LIVE wiring path
(not the no-op pipeline) emits partial-then-final segments with the correct
per-source text, and that mic ("You") and system ("They") stay fully independent.
"""

from __future__ import annotations

import struct

from loqui_sidecar.audio_ingest import (
    AUDIO_FRAME_HEADER_BYTES,
    AUDIO_SAMPLE_RATE,
    AudioIngest,
)
from loqui_sidecar.transcription import TranscriptSegment, default_transcription_manager
from loqui_sidecar.transcription.fake_stream import PHRASE_BY_MARKER, source_marker_pcm

FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * 20) // 1000  # 320 samples / 20 ms frame


def _binary_frame(source: str, seq: int, pcm: bytes) -> bytes:
    header = bytearray(AUDIO_FRAME_HEADER_BYTES)
    header[0] = 0xA0  # magic
    header[1] = 0 if source == "mic" else 1
    struct.pack_into("<I", header, 4, seq)
    struct.pack_into("<d", header, 8, seq * 20.0)
    return bytes(header) + pcm


def _drive(ingest: AudioIngest, source: str, n_frames: int) -> None:
    ingest.handle_audio_start("m-int", source)
    for i in range(n_frames):
        pcm = source_marker_pcm(source, FRAME_SAMPLES)
        ingest.handle_binary_frame(_binary_frame(source, i, pcm))
    # Trailing silence so the VAD endpoints the utterance into a final.
    for i in range(n_frames, n_frames + 40):
        silence = b"\x00" * (FRAME_SAMPLES * 2)
        ingest.handle_binary_frame(_binary_frame(source, i, silence))
    ingest.handle_audio_stop("m-int", source)


def test_live_path_emits_partial_then_final_per_source():
    # The whole gate runs with LOQUI_FAKE_ASR=1 (conftest), so the default
    # manager uses the streaming FAKE backend + the REAL pipeline.
    emitted: list[TranscriptSegment] = []
    mgr = default_transcription_manager()
    mgr.set_emitter(emitted.append)

    ingest = AudioIngest(consumers=[mgr])

    # ~2 s of speech per source then trailing silence; INTERLEAVE the two sources
    # at the frame level to prove they never cross-wire through a shared backend.
    ingest.handle_audio_start("m-int", "mic")
    ingest.handle_audio_start("m-int", "system")
    n = 100
    for i in range(n):
        ingest.handle_binary_frame(_binary_frame("mic", i, source_marker_pcm("mic", FRAME_SAMPLES)))
        ingest.handle_binary_frame(
            _binary_frame("system", i, source_marker_pcm("system", FRAME_SAMPLES))
        )
    for i in range(n, n + 40):
        silence = b"\x00" * (FRAME_SAMPLES * 2)
        ingest.handle_binary_frame(_binary_frame("mic", i, silence))
        ingest.handle_binary_frame(_binary_frame("system", i, silence))
    ingest.handle_audio_stop("m-int", "mic")
    ingest.handle_audio_stop("m-int", "system")

    by_source: dict[str, list[TranscriptSegment]] = {"mic": [], "system": []}
    for s in emitted:
        by_source[s.source].append(s)

    for source in ("mic", "system"):
        segs = by_source[source]
        assert segs, f"{source}: expected segments"
        statuses = [s.status for s in segs]
        assert "partial" in statuses, f"{source}: expected a partial"
        assert "final" in statuses, f"{source}: expected a final"
        # partial(s) precede the first final under the utterance.
        assert statuses.index("partial") < statuses.index("final")

        finals = [s for s in segs if s.status == "final"]
        # No duplicate / overlapping final seg ids.
        final_ids = [s.seg_id for s in finals]
        assert len(final_ids) == len(set(final_ids)), f"{source}: duplicate final segId"

        # Correct per-source phrase words (and ONLY this source's words).
        marker = 1 if source == "mic" else 2
        own_words = set(PHRASE_BY_MARKER[marker])
        other_marker = 2 if source == "mic" else 1
        other_words = set(PHRASE_BY_MARKER[other_marker]) - own_words
        final_text = " ".join(s.text for s in finals)
        assert any(w in final_text for w in own_words), f"{source}: own words missing"
        for w in other_words:
            assert w not in final_text.split(), f"{source}: cross-wired word {w!r}"

        # Every segment carries the right source + meeting id.
        assert all(s.source == source for s in segs)
        assert all(s.meeting_id == "m-int" for s in segs)


def test_live_path_silence_only_source_emits_nothing():
    emitted: list[TranscriptSegment] = []
    mgr = default_transcription_manager()
    mgr.set_emitter(emitted.append)
    ingest = AudioIngest(consumers=[mgr])
    ingest.handle_audio_start("m-q", "mic")
    for i in range(50):
        ingest.handle_binary_frame(_binary_frame("mic", i, b"\x00" * (FRAME_SAMPLES * 2)))
    ingest.handle_audio_stop("m-q", "mic")
    assert emitted == []
