"""run_import (PRD-12) — the seam ``app.py``'s WS ``importFile`` dispatch calls.

Drives an imported file end-to-end by REUSING the existing pipeline (no fork):

    DECODE (PyAV -> 16 kHz mono pcm_s16le frames)
      -> feed the SAME StreamingTranscriptionPipeline live capture uses
         (source="system" => single stream, diarized as Speaker N)
      -> collect the `final` segments, write the SAME files a live meeting writes:
           audio/system.wav          (so the EXISTING diarization can read it)
           transcript.jsonl          (structured, the alignment input)
           transcript.live.md        (human-facing)
      -> emit jobUpdate(kind="transcription", running/done)
    POST-PROCESS (REUSED): run_postprocess(...) -> diarization + summary
      -> emit jobUpdate(kind="diarization"|"summary", …) (from run_postprocess)
    -> emit importFileDone({meetingId, ok, transcription, diarization, summary,
                            speakers, …}) so main finalizes the meeting + indexes.

``emit`` is the per-connection notification sender app.py owns (thread-safe).
Runs OFF the WS receive loop on the post-process executor. NEVER raises into the
caller; NEVER logs api/hf tokens.

INVARIANT (carried from the live path): the AI never edits the transcript. This
module writes ``transcript.live.md`` / ``transcript.jsonl`` ONCE from the ASR
output (the import's transcription step — equivalent to the live writer), and
the reused post-process writes ONLY the derived diarized/summary files.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from ..audio_ingest import (
    AUDIO_CHANNELS,
    AUDIO_SAMPLE_RATE,
    AUDIO_SAMPLE_WIDTH_BYTES,
    meeting_audio_dir,
)
from ..providers.transcript import meeting_transcript_path
from ..transcription.manager import TranscriptionConfig, _select_backend
from ..transcription.pipeline import StreamingTranscriptionPipeline
from ..transcription.types import TranscriptSegment
from .decode import IMPORT_SOURCE, DecodeError, iter_decoded_frames

logger = logging.getLogger("loqui_sidecar.file_import.importer")

#: sidecar -> main: terminal import event (mirror of @loqui/shared IMPORT_FILE_DONE_EVENT).
IMPORT_FILE_DONE_EVENT = "importFileDone"
#: sidecar -> main: job progress (mirror of @loqui/shared EVENT.jobUpdate).
JOB_UPDATE_EVENT = "jobUpdate"
JOB_KIND_TRANSCRIPTION = "transcription"

ImportEmit = Callable[[str, dict], None]


@dataclass
class ImportFileRequest:
    """Decoded ``importFile`` notification payload (mirror of the TS
    ``ImportFileRequest``)."""

    meeting_id: str
    file_path: str
    config: object  # ProviderConfig (passed through to run_postprocess)
    api_key: Optional[str] = None
    hf_token: Optional[str] = None
    diarization_backend: str = "auto"

    @classmethod
    def from_wire(cls, obj: dict) -> "ImportFileRequest":
        from ..providers.types import ProviderConfig

        backend = str(obj.get("diarizationBackend", "auto"))
        if backend not in ("auto", "sherpa", "pyannote"):
            backend = "auto"
        return cls(
            meeting_id=str(obj.get("meetingId", "")),
            file_path=str(obj.get("filePath", "")),
            config=ProviderConfig.from_wire(obj.get("providerConfig") or {}),
            api_key=obj.get("apiKey"),
            hf_token=obj.get("hfToken"),
            diarization_backend=backend,
        )


@dataclass
class _Collector:
    """Collects the pipeline's ``final`` segments (in arrival order)."""

    finals: list[TranscriptSegment] = field(default_factory=list)

    def emit(self, segment: TranscriptSegment) -> None:
        if segment.status == "final" and segment.text.strip():
            self.finals.append(segment)


def _system_wav_path(meeting_id: str) -> Path:
    return meeting_audio_dir(meeting_id) / "system.wav"


def _write_wav(path: Path, pcm: bytes) -> None:
    """Write one 16 kHz mono pcm_s16le WAV atomically (temp + replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".wav")
    os.close(fd)
    try:
        with wave.open(tmp, "wb") as wav:
            wav.setnchannels(AUDIO_CHANNELS)
            wav.setsampwidth(AUDIO_SAMPLE_WIDTH_BYTES)
            wav.setframerate(AUDIO_SAMPLE_RATE)
            wav.writeframes(pcm)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _fmt_timestamp(seconds: float) -> str:
    """``hh:mm:ss`` (mirror of @loqui/shared formatTranscriptTimestamp)."""
    total = int(seconds) if seconds and seconds > 0 else 0
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def _one_line(text: str) -> str:
    return " ".join(text.replace("\r", " ").replace("\n", " ").split()).rstrip()


def _write_transcripts(meeting_id: str, finals: list[TranscriptSegment]) -> None:
    """Write ``transcript.jsonl`` + ``transcript.live.md`` in the EXACT shared
    format the main-process TranscriptWriter produces (so the reused alignment +
    the library/search index see identical input to a live meeting).

    Import audio is the ``system`` ("They") stream, so the ``.md`` lines read
    ``They said: …`` — matching the live system-stream rendering. Speaker
    attribution comes later from diarization (Speaker N)."""
    live_path = meeting_transcript_path(meeting_id, "live")
    jsonl_path = meeting_transcript_path(meeting_id, "structured")
    live_path.parent.mkdir(parents=True, exist_ok=True)

    md_lines: list[str] = []
    jsonl_lines: list[str] = []
    who = "You" if IMPORT_SOURCE == "mic" else "They"
    for seg in finals:
        text = _one_line(seg.text)
        md_lines.append(f"[{_fmt_timestamp(seg.t_start)}] {who} said: {text}")
        jsonl_lines.append(
            json.dumps(
                {
                    "segId": seg.seg_id,
                    "source": seg.source,
                    "tStart": seg.t_start,
                    "tEnd": seg.t_end,
                    "text": text,
                }
            )
        )
    live_path.write_text(("\n".join(md_lines) + "\n") if md_lines else "", encoding="utf-8")
    jsonl_path.write_text(("\n".join(jsonl_lines) + "\n") if jsonl_lines else "", encoding="utf-8")


def _transcribe_file(
    meeting_id: str,
    file_path: str,
    *,
    backend=None,
    config: Optional[TranscriptionConfig] = None,
) -> tuple[list[TranscriptSegment], int]:
    """Decode + transcribe ``file_path`` by REUSING the streaming pipeline.

    Returns ``(final_segments, total_pcm_bytes)``. Writes ``system.wav`` (so the
    reused diarization can read it). Raises :class:`DecodeError` if the file has
    no decodable audio.
    """
    backend = backend if backend is not None else _select_backend()
    config = config or TranscriptionConfig()
    collector = _Collector()
    pipeline = StreamingTranscriptionPipeline(
        meeting_id,
        IMPORT_SOURCE,
        collector.emit,
        backend,
        language=config.language,
    )

    pcm_chunks: list[bytes] = []
    for frame in iter_decoded_frames(file_path):
        pcm_chunks.append(frame.pcm)
        pipeline.feed(frame)
    pipeline.finish()

    pcm = b"".join(pcm_chunks)
    # Persist the decoded audio as system.wav so the reused diarization (which
    # reads <id>/audio/system.wav) has the source audio.
    _write_wav(_system_wav_path(meeting_id), pcm)
    _write_transcripts(meeting_id, collector.finals)
    return collector.finals, len(pcm)


def run_import(
    request: ImportFileRequest,
    emit: ImportEmit,
    *,
    backend=None,
    selector=None,
) -> None:
    """Run one file-import request to completion (REUSING the pipeline +
    post-process), streaming ``jobUpdate`` progress + a terminal
    ``importFileDone``. Never raises into the caller."""
    meeting_id = request.meeting_id
    transcription_stage = "skipped"
    note = ""

    # --- 1) DECODE + TRANSCRIBE (reused streaming pipeline) -------------------
    trans_id = f"{meeting_id}:transcription"
    emit(
        JOB_UPDATE_EVENT,
        {"jobId": trans_id, "kind": JOB_KIND_TRANSCRIPTION, "state": "running", "progress": 0.0},
    )
    finals: list[TranscriptSegment] = []
    try:
        finals, _bytes = _transcribe_file(meeting_id, request.file_path, backend=backend)
        transcription_stage = "done" if finals else "skipped"
        emit(
            JOB_UPDATE_EVENT,
            {
                "jobId": trans_id,
                "kind": JOB_KIND_TRANSCRIPTION,
                "state": "done",
                "progress": 1.0,
            },
        )
    except DecodeError as exc:
        logger.warning("import decode failed for %s: %s", meeting_id, exc)
        transcription_stage = "error"
        note = str(exc)
        emit(
            JOB_UPDATE_EVENT,
            {
                "jobId": trans_id,
                "kind": JOB_KIND_TRANSCRIPTION,
                "state": "error",
                "progress": 1.0,
                "error": str(exc),
            },
        )
        # No transcript -> nothing to diarize/summarize; finalize as a failed import.
        emit(
            IMPORT_FILE_DONE_EVENT,
            {
                "meetingId": meeting_id,
                "ok": False,
                "transcription": "error",
                "diarization": "skipped",
                "summary": "skipped",
                "speakers": [],
                "diarizationBackend": "",
                "summaryProvider": "",
                "summaryModel": "",
                "indexText": "",
                "note": note,
            },
        )
        return
    except Exception:  # noqa: BLE001 - import must never break the control channel.
        logger.exception("import transcription crashed for %s", meeting_id)
        emit(
            JOB_UPDATE_EVENT,
            {
                "jobId": trans_id,
                "kind": JOB_KIND_TRANSCRIPTION,
                "state": "error",
                "progress": 1.0,
                "error": "transcription failed",
            },
        )
        emit(
            IMPORT_FILE_DONE_EVENT,
            {
                "meetingId": meeting_id,
                "ok": False,
                "transcription": "error",
                "diarization": "skipped",
                "summary": "skipped",
                "speakers": [],
                "diarizationBackend": "",
                "summaryProvider": "",
                "summaryModel": "",
                "indexText": "",
                "note": "transcription failed",
            },
        )
        return

    # --- 2) POST-PROCESS (REUSED): diarization + summary ----------------------
    # Reuse the EXACT same pipeline a live meeting runs after stop. It reads the
    # transcript.jsonl + system.wav we just wrote, emits its own jobUpdate
    # (diarization/summary), writes the derived diarized + summary files, and
    # returns its terminal payload to us via a captured emitter.
    from ..postprocess import run_postprocess
    from ..postprocess.request import PostProcessRequest

    pp_terminal: dict = {}

    def pp_emit(event: str, data: dict) -> None:
        if event == "postProcessDone":
            pp_terminal.update(data)
        else:
            emit(event, data)  # forward jobUpdate(diarization|summary) verbatim.

    pp_request = PostProcessRequest(
        meeting_id=meeting_id,
        config=request.config,
        api_key=request.api_key,
        hf_token=request.hf_token,
        diarization_backend=request.diarization_backend,
    )
    try:
        run_postprocess(pp_request, pp_emit, selector=selector)
    except Exception:  # noqa: BLE001 - run_postprocess guards internally; belt-and-suspenders.
        logger.exception("import post-process crashed for %s", meeting_id)

    # --- 3) TERMINAL: importFileDone (main finalizes + indexes) ---------------
    notes = [n for n in (note, str(pp_terminal.get("note", ""))) if n]
    emit(
        IMPORT_FILE_DONE_EVENT,
        {
            "meetingId": meeting_id,
            "ok": True,
            "transcription": transcription_stage,
            "diarization": pp_terminal.get("diarization", "skipped"),
            "summary": pp_terminal.get("summary", "skipped"),
            "speakers": pp_terminal.get("speakers", []),
            "diarizationBackend": pp_terminal.get("diarizationBackend", ""),
            "summaryProvider": pp_terminal.get("summaryProvider", ""),
            "summaryModel": pp_terminal.get("summaryModel", ""),
            "indexText": pp_terminal.get("indexText", ""),
            "note": " ".join(notes).strip(),
        },
    )
