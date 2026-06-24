"""run_postprocess (PRD-5) — the seam ``app.py``'s WS ``postProcess`` dispatch
calls. Orchestrates DIARIZATION -> ALIGNMENT -> SUMMARY, emitting ``jobUpdate``
progress + a terminal ``postProcessDone``.

Flow (one ``postProcess`` notification -> ``jobUpdate``s, then one
``postProcessDone``)::

    app.py receives {type:"notification", event:"postProcess", data:{...}}
      -> run_postprocess(PostProcessRequest.from_wire(data), emit,
                         diarizer=..., selector=...)
      1) DIARIZATION (system.wav only) via the DiarizationBackend
         -> emit jobUpdate(kind="diarization", running/done|error)
      2) ALIGNMENT (pure) over the READ-ONLY structured transcript (transcript.jsonl)
         -> write transcript.diarized.{json,md}
      3) SUMMARY via the PRD-4 provider (READ-ONLY) -> write summary.json
         -> emit jobUpdate(kind="summary", running/done|error)
      -> emit postProcessDone({meetingId, diarization, summary, speakers,
                               diarizationBackend, summaryProvider/Model, indexText, note})

``emit`` is the per-connection notification sender app.py owns (``state.notify``;
thread-safe). Runs OFF the WS receive loop on the postprocess executor.

ROBUST TO PARTIAL FAILURE (PRD-5 §"Pipeline wiring", AC#4): a diarization failure
DEGRADES (every system segment -> a single "Speaker 1") and the meeting still
completes; a summary failure marks that stage "error" but still emits
``postProcessDone`` so main can finalize the meeting to "done". ``run_postprocess``
NEVER raises into app.py's worker. NEVER logs ``api_key`` / ``hf_token``.

INVARIANT: never writes transcript.live.md / transcript.jsonl / meta.json — only
the derived files (transcript.diarized.{json,md}, summary.json) via
:mod:`loqui_sidecar.postprocess.writers`.

Foundation ships the orchestration + the fake-backed happy path + graceful
degradation; the build units refine diarization (pyannote), the summary parsing,
and the index text. The diarizer + provider selector are INJECTABLE so the gate
stays hermetic (FakeDiarizer + FakeChatProvider).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from ..providers.handler import ProviderSelector, _default_provider_selector
from ..providers.transcript import FsTranscriptReader, meeting_transcript_path
from ..providers.types import ChatProviderError, ProviderConfig
from .align import align, distinct_system_speakers
from .fake import FakeDiarizer, fake_diarizer_enabled
from .pyannote_backend import PyannoteDiarizer
from .request import PostProcessRequest
from .summary import summarize
from .types import (
    JOB_KIND_DIARIZATION,
    JOB_KIND_SUMMARY,
    JOB_UPDATE_EVENT,
    POSTPROCESS_DONE_EVENT,
    DiarizationBackend,
    DiarizationResult,
    DiarizedTranscript,
    PostProcessEmit,
    TranscriptRecord,
)

logger = logging.getLogger("loqui_sidecar.postprocess.runner")

#: Builds a :class:`DiarizationBackend`. Foundation's default returns the
#: hermetic FakeDiarizer when ``LOQUI_FAKE_DIARIZER`` is set, else the real
#: PyannoteDiarizer (which itself degrades gracefully when torch/pyannote/the HF
#: token are absent). The build unit / tests may inject a different factory.
DiarizerFactory = Callable[[], DiarizationBackend]


def default_diarizer_factory() -> DiarizationBackend:
    """Return the diarizer for the current env (fake when forced, else pyannote)."""
    if fake_diarizer_enabled():
        return FakeDiarizer()
    return PyannoteDiarizer()


def _read_structured_transcript(meeting_id: str) -> list[TranscriptRecord]:
    """Read + parse ``transcript.jsonl`` (READ-ONLY) into ordered records.

    Returns ``[]`` when the file is absent or empty. Skips malformed lines so a
    single bad line never aborts alignment.
    """
    path = meeting_transcript_path(meeting_id, "structured")
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError:
        logger.exception("failed reading structured transcript for %s", meeting_id)
        return []
    out: list[TranscriptRecord] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(TranscriptRecord.from_wire(json.loads(line)))
        except (json.JSONDecodeError, ValueError, TypeError):
            logger.warning("skipping malformed transcript.jsonl line for %s", meeting_id)
    return out


def _system_wav_path(meeting_id: str) -> str:
    """Absolute path to ``<id>/audio/system.wav`` (the "They" stream)."""
    # Resolve relative to the structured-transcript path so it honors LOQUI_DATA_DIR.
    meeting_dir = meeting_transcript_path(meeting_id, "structured").parent
    return str(meeting_dir / "audio" / "system.wav")


def run_postprocess(
    request: PostProcessRequest,
    emit: PostProcessEmit,
    *,
    diarizer: Optional[DiarizationBackend] = None,
    selector: Optional[ProviderSelector] = None,
    reader: Optional[FsTranscriptReader] = None,
) -> None:
    """Run one post-processing request to completion, streaming progress via
    ``emit`` and finalizing with a ``postProcessDone``.

    * ``diarizer`` defaults to :func:`default_diarizer_factory`'s choice;
    * ``selector`` (PRD-4 provider selector) defaults to the Foundation fake-only
      selector;
    * ``reader`` defaults to the on-disk READ-ONLY transcript accessor.

    Never raises into the caller; each stage is individually guarded.
    """
    meeting_id = request.meeting_id
    diarizer = diarizer or default_diarizer_factory()
    selector = selector or _default_provider_selector
    reader = reader or FsTranscriptReader()

    diar_stage = "skipped"
    summary_stage = "skipped"
    speakers: list[str] = []
    diar_backend = ""
    summary_provider = ""
    summary_model = ""
    index_parts: list[str] = []
    notes: list[str] = []

    segments = _read_structured_transcript(meeting_id)

    # --- 1) DIARIZATION + 2) ALIGNMENT (skipped when regenerate-summary only) ---
    if not request.regenerate_summary:
        diar_id = f"{meeting_id}:diarization"
        emit(
            JOB_UPDATE_EVENT,
            {"jobId": diar_id, "kind": JOB_KIND_DIARIZATION, "state": "running", "progress": 0.0},
        )
        try:
            result = diarizer.diarize(_system_wav_path(meeting_id), request.hf_token)
        except Exception:  # noqa: BLE001 - a backend crash degrades, never fatal.
            logger.exception("diarization backend crashed for %s", meeting_id)
            result = DiarizationResult(
                diarized=False,
                backend=getattr(diarizer, "name", ""),
                note="diarization failed unexpectedly",
            )
        diar_backend = result.backend
        if result.note:
            notes.append(result.note)

        diarized_segments = align(segments, result.turns)
        speakers = distinct_system_speakers(diarized_segments)
        diarized = DiarizedTranscript(
            meeting_id=meeting_id,
            diarized=result.diarized,
            backend=result.backend,
            speakers=speakers,
            segments=diarized_segments,
        )
        try:
            from .writers import write_diarized_transcript

            write_diarized_transcript(diarized)
            # The derived file is ALWAYS written (a degraded run still gives every
            # system segment a coherent fallback "Speaker 1"). The diarization JOB
            # itself completed (state="done" — the only terminal-OK value in the
            # shared jobStateSchema {queued,running,done,error,canceled}; "skipped"
            # is NOT a valid jobUpdate state). The skip/degrade OUTCOME rides on the
            # terminal ``postProcessDone.diarization`` stage ("skipped") + its
            # ``note`` (postProcessStageSchema, which DOES allow "skipped") so main
            # + the UI learn diarization didn't really run, without violating the
            # jobUpdate contract.
            diar_stage = "done" if result.diarized else "skipped"
            index_parts.append(" ".join(s.text for s in diarized_segments if s.text))
            emit(
                JOB_UPDATE_EVENT,
                {"jobId": diar_id, "kind": JOB_KIND_DIARIZATION, "state": "done", "progress": 1.0},
            )
        except Exception:  # noqa: BLE001 - write failure marks the stage error.
            logger.exception("writing diarized transcript failed for %s", meeting_id)
            diar_stage = "error"
            emit(
                JOB_UPDATE_EVENT,
                {
                    "jobId": diar_id,
                    "kind": JOB_KIND_DIARIZATION,
                    "state": "error",
                    "progress": 1.0,
                    "error": "failed to write diarized transcript",
                },
            )

    # --- 3) SUMMARY (via the PRD-4 provider, read-only) ------------------------
    sum_id = f"{meeting_id}:summary"
    emit(
        JOB_UPDATE_EVENT,
        {"jobId": sum_id, "kind": JOB_KIND_SUMMARY, "state": "running", "progress": 0.0},
    )
    try:
        config: ProviderConfig = request.config
        provider = selector(config)
        summary = summarize(meeting_id, provider, config, api_key=request.api_key, reader=reader)
        summary.generated_at = datetime.now(timezone.utc).isoformat()
        from .writers import write_summary

        write_summary(summary)
        summary_stage = "done"
        summary_provider = summary.provider
        summary_model = summary.model
        # Fold the structured summary into the searchable index, mirroring the
        # main-side buildIndexText (render.ts) so a re-index after a rename
        # reproduces the same searchable text.
        if summary.tldr:
            index_parts.append(summary.tldr)
        index_parts.extend(d for d in summary.decisions if d)
        for item in summary.action_items:
            if item.text:
                index_parts.append(f"{item.owner}: {item.text}" if item.owner else item.text)
        index_parts.extend(t for t in summary.topics if t)
        emit(
            JOB_UPDATE_EVENT,
            {"jobId": sum_id, "kind": JOB_KIND_SUMMARY, "state": "done", "progress": 1.0},
        )
    except ChatProviderError as exc:
        logger.warning("summary for %s failed: [%s] %s", meeting_id, exc.code, exc)
        summary_stage = "error"
        notes.append(str(exc))
        emit(
            JOB_UPDATE_EVENT,
            {
                "jobId": sum_id,
                "kind": JOB_KIND_SUMMARY,
                "state": "error",
                "progress": 1.0,
                "error": str(exc),
            },
        )
    except Exception:  # noqa: BLE001 - summary failure must not abort finalize.
        logger.exception("summary for %s crashed", meeting_id)
        summary_stage = "error"
        emit(
            JOB_UPDATE_EVENT,
            {
                "jobId": sum_id,
                "kind": JOB_KIND_SUMMARY,
                "state": "error",
                "progress": 1.0,
                "error": "summary generation failed",
            },
        )

    # --- Terminal: hand main the data to index + finalize ----------------------
    emit(
        POSTPROCESS_DONE_EVENT,
        {
            "meetingId": meeting_id,
            "diarization": diar_stage,
            "summary": summary_stage,
            "speakers": speakers,
            "diarizationBackend": diar_backend,
            "summaryProvider": summary_provider,
            "summaryModel": summary_model,
            "indexText": " ".join(p for p in index_parts if p).strip(),
            "note": " ".join(notes).strip(),
        },
    )
