"""WhisperLive streaming transcription core (adapted, PRD-2 live engine).

This is a faithful port of the streaming algorithm from **WhisperLive**
(collabora/WhisperLive, MIT, pinned to v0.9.0 — `whisper_live/backend/base.py`
+ `whisper_live/backend/faster_whisper_backend.py`), trimmed to exactly what
Loqui's live transcript needs:

* a growing float32 audio buffer (``add_frames``) with the same 45s/30s trim;
* the same windowed re-decode loop (``run``/``speech_to_text``) keyed off a
  ``timestamp_offset`` that advances only past COMPLETED segments;
* the same segment-commit logic (``update_segments``) — full segments commit, and
  a repeated incomplete tail commits after ``same_output_threshold`` repeats.

Deliberately DROPPED (not needed here; keeps us torch-free + lean): WhisperLive's
torch CUDA probe (Loqui is CPU/int8), its torch Silero VAD (we use
faster-whisper's BUILT-IN ``vad_filter`` over onnxruntime), translation, speaker
diarization, word timestamps, batch worker, metrics, and the WebSocket transport
(replaced by an injected ``on_result`` callback). The faster-whisper
``WhisperModel`` is INJECTED so the hermetic gate drives a fake (no model).

Upstream © Collabora Ltd., MIT License (see THIRD_PARTY_LICENSES). Loqui changes:
the adaptations listed above.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Optional

import numpy as np

logger = logging.getLogger("loqui_sidecar.transcription.whisperlive")

#: A streamed segment dict (mirror of WhisperLive's): seconds (float) + text +
#: whether it is COMMITTED (``completed=True``) or the in-progress tail.
Segment = dict
#: Sink called with the current list of recent segments after each decode.
OnResult = Callable[[list[Segment]], None]


class WhisperLiveTranscriber:
    """One streaming faster-whisper session for a single audio source.

    Feed mono 16 kHz float32 audio via :meth:`add_frames`; a background thread
    re-decodes the buffer and calls ``on_result`` with the recent segments
    (committed + the in-progress tail). Call :meth:`stop` to end the thread.
    """

    RATE = 16000
    MAX_BUFFER_DURATION_S = 45
    BUFFER_TRIM_DURATION_S = 30
    CLIP_THRESHOLD_DURATION_S = 25
    CLIP_TAIL_DURATION_S = 5
    MAX_TRANSCRIPT_LENGTH = 500

    def __init__(
        self,
        model: Any,
        on_result: OnResult,
        *,
        language: Optional[str] = None,
        task: str = "transcribe",
        use_vad: bool = True,
        vad_parameters: Optional[dict] = None,
        send_last_n_segments: int = 10,
        no_speech_thresh: float = 0.45,
        clip_audio: bool = True,
        same_output_threshold: int = 7,
        on_language: Optional[Callable[[str], None]] = None,
        start: bool = True,
    ) -> None:
        self._model = model
        self._on_result = on_result
        self._on_language = on_language
        self.language = language
        self.task = task
        self.use_vad = use_vad
        self.vad_parameters = vad_parameters or {"threshold": 0.5}
        self.send_last_n_segments = send_last_n_segments
        self.no_speech_thresh = no_speech_thresh
        self.clip_audio = clip_audio
        self.same_output_threshold = same_output_threshold

        self.frames_np: Optional[np.ndarray] = None
        self.frames_offset = 0.0
        self.timestamp_offset = 0.0
        self.text: list[str] = []
        self.current_out = ""
        self.prev_out = ""
        self.same_output_count = 0
        self.end_time_for_same_output: Optional[float] = None
        self.transcript: list[Segment] = []
        self.exit = False
        self.lock = threading.Lock()
        # The background decode loop. Optional so tests can drive _handle_output /
        # _update_segments deterministically without the timing-dependent thread.
        self._thread: Optional[threading.Thread] = None
        if start:
            self._thread = threading.Thread(target=self.run, name="whisperlive", daemon=True)
            self._thread.start()

    # -- audio in -------------------------------------------------------------

    def add_frames(self, frame_np: np.ndarray) -> None:
        """Append float32 mono audio to the buffer (trims to keep it bounded)."""
        with self.lock:
            if (
                self.frames_np is not None
                and self.frames_np.shape[0] > self.MAX_BUFFER_DURATION_S * self.RATE
            ):
                self.frames_offset += float(self.BUFFER_TRIM_DURATION_S)
                self.frames_np = self.frames_np[int(self.BUFFER_TRIM_DURATION_S * self.RATE) :]
                if self.timestamp_offset < self.frames_offset:
                    self.timestamp_offset = self.frames_offset
            if self.frames_np is None:
                self.frames_np = frame_np.copy()
            else:
                self.frames_np = np.concatenate((self.frames_np, frame_np), axis=0)

    def stop(self) -> None:
        self.exit = True

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    # -- the streaming loop ---------------------------------------------------

    def run(self) -> None:
        while not self.exit:
            if self.frames_np is None:
                time.sleep(0.02)
                continue
            if self.clip_audio:
                self._clip_audio_if_no_valid_segment()
            input_bytes, duration = self._get_audio_chunk_for_processing()
            if duration < 1.0:
                time.sleep(0.1)
                continue
            try:
                result = self._transcribe_audio(input_bytes.copy())
                if result is None or self.language is None:
                    self.timestamp_offset += duration
                    time.sleep(0.25)
                    continue
                self._handle_output(result, duration)
            except Exception:  # noqa: BLE001 - a decode error degrades to a retry, never fatal.
                logger.exception("whisperlive decode failed")
                time.sleep(0.05)

    def _clip_audio_if_no_valid_segment(self) -> None:
        with self.lock:
            if self.frames_np is None:
                return
            pending = self.frames_np[int((self.timestamp_offset - self.frames_offset) * self.RATE) :]
            if pending.shape[0] > self.CLIP_THRESHOLD_DURATION_S * self.RATE:
                duration = self.frames_np.shape[0] / self.RATE
                self.timestamp_offset = self.frames_offset + duration - self.CLIP_TAIL_DURATION_S

    def _get_audio_chunk_for_processing(self) -> "tuple[np.ndarray, float]":
        with self.lock:
            samples_take = max(0, (self.timestamp_offset - self.frames_offset) * self.RATE)
            input_bytes = self.frames_np[int(samples_take) :].copy()
        return input_bytes, input_bytes.shape[0] / self.RATE

    def _transcribe_audio(self, input_sample: np.ndarray):
        result, info = self._model.transcribe(
            input_sample,
            initial_prompt=None,
            language=self.language,
            task=self.task,
            vad_filter=self.use_vad,
            vad_parameters=self.vad_parameters if self.use_vad else None,
        )
        if self.language is None and info is not None:
            prob = float(getattr(info, "language_probability", 0.0) or 0.0)
            detected = getattr(info, "language", None)
            if detected and prob > 0.5:
                self.language = detected
                if self._on_language is not None:
                    self._on_language(detected)
        return list(result)

    # -- segment handling (faithful to WhisperLive) ---------------------------

    @staticmethod
    def _seg_start(s: Any) -> float:
        return float(getattr(s, "start", getattr(s, "start_ts", 0)) or 0)

    @staticmethod
    def _seg_end(s: Any) -> float:
        return float(getattr(s, "end", getattr(s, "end_ts", 0)) or 0)

    @staticmethod
    def _seg_no_speech(s: Any) -> float:
        return float(getattr(s, "no_speech_prob", 0) or 0)

    @staticmethod
    def _format_segment(start: float, end: float, text: str, completed: bool) -> Segment:
        return {"start": round(float(start), 3), "end": round(float(end), 3), "text": text, "completed": completed}

    def _handle_output(self, result: list, duration: float) -> None:
        if not result:
            return
        last_segment = self._update_segments(result, duration)
        segments: list[Segment] = (
            self.transcript[-self.send_last_n_segments :].copy()
            if len(self.transcript) >= self.send_last_n_segments
            else self.transcript.copy()
        )
        if last_segment is not None:
            segments = segments + [last_segment]
        if segments:
            try:
                self._on_result(segments)
            except Exception:  # noqa: BLE001 - the sink must never break the loop.
                logger.exception("whisperlive on_result sink raised")

    def _update_segments(self, segments: list, duration: float) -> Optional[Segment]:
        offset: Optional[float] = None
        self.current_out = ""
        last_segment: Optional[Segment] = None

        if len(segments) > 1 and self._seg_no_speech(segments[-1]) <= self.no_speech_thresh:
            for s in segments[:-1]:
                text_ = s.text
                self.text.append(text_)
                start = self.timestamp_offset + self._seg_start(s)
                end = self.timestamp_offset + min(duration, self._seg_end(s))
                if start >= end:
                    continue
                if self._seg_no_speech(s) > self.no_speech_thresh:
                    continue
                self.transcript.append(self._format_segment(start, end, text_, completed=True))
                offset = min(duration, self._seg_end(s))

        if self._seg_no_speech(segments[-1]) <= self.no_speech_thresh:
            self.current_out += segments[-1].text
            last_segment = self._format_segment(
                self.timestamp_offset + self._seg_start(segments[-1]),
                self.timestamp_offset + min(duration, self._seg_end(segments[-1])),
                self.current_out,
                completed=False,
            )

        if self.current_out.strip() == self.prev_out.strip() and self.current_out != "":
            self.same_output_count += 1
            if self.end_time_for_same_output is None:
                self.end_time_for_same_output = self._seg_end(segments[-1])
            time.sleep(0.1)
        else:
            self.same_output_count = 0
            self.end_time_for_same_output = None

        if self.same_output_count > self.same_output_threshold:
            if not self.text or self.text[-1].strip().lower() != self.current_out.strip().lower():
                self.text.append(self.current_out)
                self.transcript.append(
                    self._format_segment(
                        self.timestamp_offset,
                        self.timestamp_offset + min(duration, self.end_time_for_same_output or 0.0),
                        self.current_out,
                        completed=True,
                    )
                )
            self.current_out = ""
            offset = min(duration, self.end_time_for_same_output or 0.0)
            self.same_output_count = 0
            last_segment = None
            self.end_time_for_same_output = None
        else:
            self.prev_out = self.current_out

        if offset is not None:
            with self.lock:
                self.timestamp_offset += offset

        if len(self.transcript) > self.MAX_TRANSCRIPT_LENGTH:
            self.transcript = self.transcript[-self.MAX_TRANSCRIPT_LENGTH :]
        if len(self.text) > self.MAX_TRANSCRIPT_LENGTH:
            self.text = self.text[-self.MAX_TRANSCRIPT_LENGTH :]
        return last_segment
