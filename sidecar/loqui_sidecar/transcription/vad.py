"""Lightweight, dependency-free streaming VAD endpointer (PRD-2 build unit).

This is the *streaming endpointer* the transcription pipeline uses to cut a
continuous 16 kHz mono ``pcm_s16le`` stream into utterance chunks at silence
boundaries. It is deliberately **dependency-free** (stdlib only — no numpy, no
torch, no Silero) so it is fast and unit-testable on synthetic signals without
any model download or heavy import. faster-whisper's own ``vad_filter`` can
*additionally* clean the ASR input inside :mod:`asr_backend`, but this
endpointer must stand alone.

Algorithm (per fixed-size analysis frame):

* Split the incoming PCM into fixed ``frame_ms`` analysis frames (default 20 ms
  = 320 samples @ 16 kHz). A trailing partial frame is buffered and prepended to
  the next :meth:`StreamingVad.feed` call so frame boundaries stay stable across
  arbitrary chunking of the input stream.
* Classify each frame as speech/non-speech using two cheap, robust features:
  short-time energy (RMS) AND zero-crossing rate (ZCR). A frame counts as speech
  when its RMS clears an adaptive noise-floor-relative threshold (so it tolerates
  varying ambient levels) AND its ZCR is not implausibly high (a crude unvoiced/
  fricative-vs-hiss guard). The noise floor adapts slowly downward toward the
  quietest recent frames so silence after a loud passage is still detected.
* Apply hysteresis with a configurable **silence hangover**: a speech segment
  opens after ``speech_onset_frames`` consecutive speech frames and closes only
  after ``hangover_frames`` consecutive non-speech frames (``hangover_ms``). The
  hangover trailing silence is *not* trimmed from the emitted segment so a word's
  final phoneme is never clipped.

The endpointer yields :class:`SpeechSegment` boundaries in **seconds relative to
the start of the stream** (the pipeline shifts them onto the meeting timeline).
It carries no audio itself — the caller keeps the PCM buffer and slices it by the
returned ``[t_start, t_end)``.
"""

from __future__ import annotations

import array
from dataclasses import dataclass
from typing import Iterator, List, Optional

from .types import AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_WIDTH_BYTES

#: Full-scale magnitude of a signed 16-bit PCM sample.
_INT16_FULL_SCALE = 32768.0


@dataclass(frozen=True)
class SpeechSegment:
    """One detected speech span, in seconds relative to the stream start.

    ``t_end`` includes the trailing hangover silence (so the final phoneme is
    not clipped). ``[t_start, t_end)`` is a half-open interval; multiply by the
    sample rate to slice the caller's PCM buffer.
    """

    t_start: float
    t_end: float

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start


@dataclass
class VadConfig:
    """Tunables for :class:`StreamingVad`.

    Defaults target conversational speech at 16 kHz. ``aggressiveness`` (0..1,
    mirrors :attr:`TranscriptionConfig.vad_aggressiveness`) scales the energy
    threshold: higher = more aggressive gating (needs louder audio to count as
    speech), reducing false speech on noise at the cost of clipping quiet onsets.
    """

    sample_rate: int = AUDIO_SAMPLE_RATE
    #: Analysis frame size in milliseconds (20 ms = 320 samples @ 16 kHz).
    frame_ms: float = 20.0
    #: Silence required to CLOSE an open speech segment (the hangover).
    hangover_ms: float = 300.0
    #: Consecutive speech frames required to OPEN a segment (debounces blips).
    onset_ms: float = 60.0
    #: 0..1 gating aggressiveness; scales the speech energy threshold.
    aggressiveness: float = 0.5
    #: Absolute floor on the speech RMS threshold (normalized 0..1 full-scale),
    #: so pure-silence input never trips on numerical noise.
    min_rms_threshold: float = 0.012
    #: Multiplier over the adaptive noise floor that RMS must exceed for speech.
    rms_over_floor: float = 3.0
    #: Reject a frame as speech if its zero-crossing rate exceeds this (0..1).
    #: Very high ZCR with low energy is hiss/noise, not voiced speech.
    max_zcr: float = 0.60
    #: How fast the noise floor adapts toward the current frame's RMS (0..1).
    noise_adapt: float = 0.05

    def __post_init__(self) -> None:
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if self.frame_ms <= 0:
            raise ValueError("frame_ms must be positive")
        if not 0.0 <= self.aggressiveness <= 1.0:
            raise ValueError("aggressiveness must be in [0, 1]")

    @property
    def frame_samples(self) -> int:
        return max(1, int(round(self.sample_rate * self.frame_ms / 1000.0)))

    @property
    def onset_frames(self) -> int:
        return max(1, int(round(self.onset_ms / self.frame_ms)))

    @property
    def hangover_frames(self) -> int:
        return max(1, int(round(self.hangover_ms / self.frame_ms)))


def _frame_features(samples: array.array, start: int, n: int) -> tuple[float, float]:
    """Return ``(rms, zcr)`` for ``samples[start:start+n]``, both normalized 0..1.

    ``rms`` is normalized to 0..1 full-scale; ``zcr`` is the fraction of adjacent
    sample pairs that change sign (0..1). Pure stdlib, no numpy.
    """
    if n <= 0:
        return 0.0, 0.0
    energy = 0.0
    crossings = 0
    prev = samples[start]
    energy += float(prev) * float(prev)
    for i in range(start + 1, start + n):
        s = samples[i]
        energy += float(s) * float(s)
        # Sign change (treat 0 as non-negative; only count strict crossings).
        if (prev < 0) != (s < 0):
            crossings += 1
        prev = s
    rms = (energy / n) ** 0.5 / _INT16_FULL_SCALE
    zcr = crossings / (n - 1) if n > 1 else 0.0
    return rms, zcr


class StreamingVad:
    """Stateful, streaming energy/ZCR VAD endpointer over 16 kHz mono pcm_s16le.

    Feed it arbitrary-length ``pcm_s16le`` chunks via :meth:`feed`; it yields a
    :class:`SpeechSegment` each time a speech span *closes* (after the silence
    hangover). Call :meth:`flush` at end-of-stream to close any still-open span.
    The instance tracks absolute stream time across calls so segment boundaries
    are continuous regardless of how the input is chunked.

    Robustness: malformed input (an odd trailing byte) is tolerated — the ragged
    byte is buffered and joined with the next chunk, never dropped silently in a
    way that desyncs sample alignment.
    """

    def __init__(self, config: Optional[VadConfig] = None) -> None:
        self.config = config or VadConfig()
        # Speech RMS threshold = max(absolute floor, floor*multiplier), scaled by
        # aggressiveness (0 -> 0.5x, 1 -> 1.5x of the configured floor).
        self._agg_scale = 0.5 + self.config.aggressiveness
        self._noise_floor = self.config.min_rms_threshold
        # Carry an unaligned/partial-frame remainder between feed() calls.
        self._carry = array.array("h")
        # Carry a lone odd byte (half a sample) so it joins the next chunk.
        self._odd_byte = b""
        # Hysteresis state.
        self._in_speech = False
        self._speech_run = 0  # consecutive speech frames while not in_speech
        self._silence_run = 0  # consecutive non-speech frames while in_speech
        # Absolute sample index of the next frame to be processed.
        self._samples_consumed = 0
        # Start sample of the currently open segment (None when not in speech).
        self._seg_start_sample: Optional[int] = None

    # -- public API -----------------------------------------------------------

    def feed(self, pcm: bytes) -> List[SpeechSegment]:
        """Process a chunk of ``pcm_s16le`` audio; return any segments that closed.

        Buffers any trailing partial analysis frame for the next call so frame
        boundaries are stable across arbitrary input chunking.
        """
        segments: List[SpeechSegment] = []
        if not pcm:
            return segments
        # Join any carried lone odd byte from the previous chunk, then split into
        # whole 16-bit samples; a new ragged trailing byte is carried forward so
        # sample alignment is never desynced by arbitrary chunk boundaries.
        raw = self._odd_byte + pcm if self._odd_byte else pcm
        usable = len(raw) - (len(raw) % AUDIO_SAMPLE_WIDTH_BYTES)
        self._odd_byte = raw[usable:]
        new = array.array("h")
        new.frombytes(raw[:usable])
        # Prepend the carried (< one frame) sample remainder.
        if self._carry:
            buf = self._carry
            buf.extend(new)
        else:
            buf = new
        self._carry = array.array("h")

        fs = self.config.frame_samples
        total = len(buf)
        n_frames = total // fs
        consumed = n_frames * fs
        for f in range(n_frames):
            seg = self._process_frame(buf, f * fs, fs)
            if seg is not None:
                segments.append(seg)
        # Carry the leftover (< one frame) samples to the next feed().
        leftover = buf[consumed:]
        self._carry = array.array("h", leftover)
        return segments

    def flush(self) -> List[SpeechSegment]:
        """End-of-stream: process the carried remainder and close any open span.

        The carried sub-frame remainder is analyzed as a final (short) frame so a
        trailing utterance is not lost; then any open segment is closed at the
        current stream end.
        """
        segments: List[SpeechSegment] = []
        if self._carry:
            seg = self._process_frame(self._carry, 0, len(self._carry))
            if seg is not None:
                segments.append(seg)
            self._carry = array.array("h")
        if self._in_speech and self._seg_start_sample is not None:
            end_sample = self._samples_consumed
            segments.append(self._close_segment(end_sample))
        return segments

    def reset(self) -> None:
        """Clear all state (utterance/stream boundary)."""
        self._noise_floor = self.config.min_rms_threshold
        self._carry = array.array("h")
        self._odd_byte = b""
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0
        self._samples_consumed = 0
        self._seg_start_sample = None

    def iter_segments(self, pcm: bytes) -> Iterator[SpeechSegment]:
        """Convenience: feed one buffer and flush, yielding all segments.

        Useful for tests / one-shot use over a complete buffer.
        """
        yield from self.feed(pcm)
        yield from self.flush()

    # -- internals ------------------------------------------------------------

    def _process_frame(self, buf: array.array, start: int, n: int) -> Optional[SpeechSegment]:
        """Classify one frame and advance the hysteresis state machine.

        Returns a :class:`SpeechSegment` iff a speech span closed on this frame.
        """
        rms, zcr = _frame_features(buf, start, n)
        frame_start_sample = self._samples_consumed
        self._samples_consumed += n

        is_speech = self._classify(rms, zcr)
        # Adapt the noise floor toward quiet frames (only when NOT speech), so a
        # long silence relaxes the threshold without chasing speech energy up.
        if not is_speech:
            a = self.config.noise_adapt
            self._noise_floor = (1.0 - a) * self._noise_floor + a * rms

        closed: Optional[SpeechSegment] = None
        if not self._in_speech:
            if is_speech:
                self._speech_run += 1
                if self._speech_run >= self.config.onset_frames:
                    # Open a segment, back-dating its start to the first speech
                    # frame of this onset run (so the onset isn't clipped).
                    self._in_speech = True
                    self._seg_start_sample = frame_start_sample - ((self._speech_run - 1) * n)
                    if self._seg_start_sample < 0:
                        self._seg_start_sample = 0
                    self._silence_run = 0
            else:
                self._speech_run = 0
        else:
            if is_speech:
                self._silence_run = 0
            else:
                self._silence_run += 1
                if self._silence_run >= self.config.hangover_frames:
                    # Close at the current frame end (hangover silence included).
                    closed = self._close_segment(self._samples_consumed)
        return closed

    def _classify(self, rms: float, zcr: float) -> bool:
        threshold = max(
            self.config.min_rms_threshold,
            self._noise_floor * self.config.rms_over_floor,
        )
        threshold *= self._agg_scale
        if rms < threshold:
            return False
        if zcr > self.config.max_zcr:
            # High ZCR + low-ish energy is hiss/noise; require extra energy.
            return rms >= threshold * 2.0
        return True

    def _close_segment(self, end_sample: int) -> SpeechSegment:
        start_sample = self._seg_start_sample or 0
        sr = float(self.config.sample_rate)
        seg = SpeechSegment(t_start=start_sample / sr, t_end=end_sample / sr)
        self._in_speech = False
        self._seg_start_sample = None
        self._speech_run = 0
        self._silence_run = 0
        return seg
