"""Deterministic streaming FAKE-ASR script for the hermetic live path + smoke.

The default :class:`~loqui_sidecar.transcription.FakeAsrBackend` ships a
*silent* script (recognizes nothing). For the end-to-end transcription path —
both the in-process integration tests and ``scripts/smoke-transcription.mjs``
(spawned with ``LOQUI_FAKE_ASR=1``) — we need a fake that, with NO model and NO
inference, produces realistic streaming output: a growing hypothesis that
LocalAgreement-2 can stabilize into ``final`` segments, AND distinct text per
source so the smoke can prove mic ("You") and system ("They") stay independent.

The streaming pipeline re-decodes a GROWING window of the live utterance buffer
every ``decode_interval_seconds``. So this script:

* keys the *phrase* off a content signature of the PCM (a source marker the
  producer embeds — see :func:`source_marker_pcm`), so mic-tagged audio always
  decodes to the mic phrase and system-tagged audio to the system phrase,
  regardless of decode order or a shared backend instance; and
* reveals words proportional to the buffered duration, so each successive decode
  on the growing buffer repeats the prior decode's prefix and appends one or
  more new words — exactly the "stable repeat" LocalAgreement-2 needs to commit
  a prefix as ``final`` while the tail stays ``partial``.

It is pure + deterministic: identical ``(pcm bytes)`` -> identical tokens. No
state is kept here (a :class:`FakeAsrBackend`'s own ``decode_count`` is ignored),
so a single backend instance shared across the mic + system pipelines stays
correct: text is decided by the buffer content, never by call order.
"""

from __future__ import annotations

from typing import List

from .types import AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_WIDTH_BYTES, AsrToken

#: The two scripted phrases, one per source. Distinct word sets so the smoke can
#: assert the streams never cross-wired (mic text never appears on system).
PHRASE_BY_MARKER: dict[int, List[str]] = {
    # mic ("You")
    1: ["hello", "there", "this", "is", "the", "microphone", "speaking", "now"],
    # system ("They")
    2: ["the", "remote", "meeting", "audio", "is", "playing", "back", "clearly"],
}

#: Seconds of buffered audio that "reveals" one more word in the hypothesis.
#: Tuned so a few hundred ms of audio per decode grows the hypothesis by ~1 word,
#: giving LocalAgreement-2 several stable-prefix steps within a short utterance.
_SECONDS_PER_WORD = 0.25

#: Distinct per-sample amplitudes the producer writes so a buffer's marker is
#: recoverable from its content. ``source_marker_pcm`` builds frames of these.
_MARKER_SAMPLE: dict[int, int] = {1: 6000, 2: 12000}


def source_marker_pcm(source: str, num_samples: int) -> bytes:
    """Build ``num_samples`` of mono pcm_s16le carrying this source's marker.

    The streaming fake recovers the marker (and thus the phrase) from the buffer
    content via :func:`_marker_of`, so producers (tests + the smoke) must tag
    each frame with the matching constant amplitude. mic -> 1, system -> 2.
    """
    marker = 1 if source == "mic" else 2
    sample = _MARKER_SAMPLE[marker]
    return sample.to_bytes(2, "little", signed=True) * num_samples


def _marker_of(pcm: bytes) -> int:
    """Recover the source marker from a PCM buffer's dominant sample value.

    Returns 1 (mic), 2 (system), or 0 (unrecognized -> silent). Reads the first
    sample (the producer fills the whole frame with the marker sample), so this
    is O(1) and never scans the buffer.
    """
    if len(pcm) < AUDIO_SAMPLE_WIDTH_BYTES:
        return 0
    first = int.from_bytes(pcm[:AUDIO_SAMPLE_WIDTH_BYTES], "little", signed=True)
    best_marker = 0
    best_delta = None
    for marker, sample in _MARKER_SAMPLE.items():
        delta = abs(first - sample)
        if best_delta is None or delta < best_delta:
            best_delta = delta
            best_marker = marker
    # Require the sample to be reasonably close to a known marker; otherwise the
    # buffer is not one of ours -> recognize nothing (silence).
    if best_delta is not None and best_delta <= 1500:
        return best_marker
    return 0


def streaming_fake_script(_decode_index: int, pcm_bytes: int) -> List[AsrToken]:
    """Legacy ``FakeScript`` shape (index + byte length only): not source-aware.

    Kept for callers that only have the byte length. Prefer
    :func:`make_streaming_fake_backend`, whose backend inspects the PCM content
    so per-source phrases are correct with a shared backend instance.
    """
    # Without the PCM we cannot tell the source apart; default to the mic phrase.
    return _tokens_for(1, pcm_bytes)


def _tokens_for(marker: int, pcm_bytes: int) -> List[AsrToken]:
    if marker == 0:
        return []
    phrase = PHRASE_BY_MARKER[marker]
    usable = pcm_bytes - (pcm_bytes % AUDIO_SAMPLE_WIDTH_BYTES)
    seconds = (usable // AUDIO_SAMPLE_WIDTH_BYTES) / float(AUDIO_SAMPLE_RATE)
    words = int(seconds / _SECONDS_PER_WORD)
    words = max(1, min(words, len(phrase)))
    tokens: List[AsrToken] = []
    for i in range(words):
        t_start = i * _SECONDS_PER_WORD
        t_end = t_start + _SECONDS_PER_WORD
        tokens.append(AsrToken(text=phrase[i], t_start=t_start, t_end=t_end))
    return tokens


def make_streaming_fake_backend(name: str = "fake-stream"):
    """A :class:`~loqui_sidecar.transcription.FakeAsrBackend` whose decodes are
    source-aware (phrase chosen from the PCM marker) and grow with buffer length.

    Safe to share across the mic + system pipelines: output depends only on the
    buffer content handed to ``transcribe``, not on call order or shared state.
    """
    from .fake_backend import FakeAsrBackend

    backend = FakeAsrBackend(name=name)

    # Override transcribe to inspect PCM content (the base FakeScript only sees
    # the byte length, which cannot distinguish sources). Deterministic + pure.
    def transcribe(pcm, sample_rate=AUDIO_SAMPLE_RATE, language=None, on_language=None):
        backend.decode_count += 1
        backend.total_pcm_bytes += len(pcm)
        return _tokens_for(_marker_of(bytes(pcm)), len(pcm))

    backend.transcribe = transcribe  # type: ignore[method-assign]
    return backend
