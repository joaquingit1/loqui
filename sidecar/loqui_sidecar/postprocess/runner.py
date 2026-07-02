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
import os
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone
from typing import Callable, Optional

from ..providers.handler import ProviderSelector, _default_provider_selector
from ..providers.transcript import FsTranscriptReader, meeting_transcript_path
from ..providers.types import ChatProviderError, ProviderConfig
from .align import align, distinct_system_speakers
from .fake import FakeDiarizer, fake_diarizer_enabled
from .pyannote_backend import PyannoteDiarizer
from .request import PostProcessRequest
from .retranscribe import re_transcribe_meeting
from .sherpa_backend import SherpaOnnxDiarizer
from .summary import summarize
from .types import (
    JOB_KIND_DIARIZATION,
    JOB_KIND_SUMMARY,
    JOB_KIND_TRANSCRIPTION,
    JOB_UPDATE_EVENT,
    POSTPROCESS_DONE_EVENT,
    SUMMARY_TOKEN_EVENT,
    DiarizationBackend,
    DiarizationResult,
    DiarizedTranscript,
    PostProcessEmit,
    TranscriptRecord,
)
from .writers import hifi_jsonl_path

logger = logging.getLogger("loqui_sidecar.postprocess.runner")

#: Hard cap on summary generation so a hung/slow provider can NEVER leave a
#: meeting stuck in "processing" forever — on timeout the summary stage is marked
#: "error" and the meeting still finalizes to "done". Env-overridable; <= 0
#: disables the cap.
SUMMARY_TIMEOUT_ENV = "LOQUI_SUMMARY_TIMEOUT_SEC"
DEFAULT_SUMMARY_TIMEOUT_SEC = 120.0


def _resolved_summary_timeout() -> Optional[float]:
    raw = (os.environ.get(SUMMARY_TIMEOUT_ENV) or "").strip()
    try:
        value = float(raw) if raw else DEFAULT_SUMMARY_TIMEOUT_SEC
    except ValueError:
        value = DEFAULT_SUMMARY_TIMEOUT_SEC
    return value if value > 0 else None


#: Builds a :class:`DiarizationBackend` for the current env + an optional HF token.
#: The default (:func:`default_diarizer_factory`) selects, in order: the hermetic
#: FakeDiarizer when ``LOQUI_FAKE_DIARIZER`` is set (the gate); explicit user
#: selection when configured; else ``auto`` chooses pyannote with an HF token and
#: sherpa without one. The build unit / tests may inject a different factory.
DiarizerFactory = Callable[[Optional[str], str], DiarizationBackend]


def default_diarizer_factory(
    hf_token: Optional[str] = None,
    diarization_backend: str = "auto",
) -> DiarizationBackend:
    """Select the diarization backend for the current env (PRD-14).

    Selection order:

    1. ``LOQUI_FAKE_DIARIZER`` set -> :class:`FakeDiarizer` (the hermetic gate +
       smoke; deterministic, no model/network).
    2. explicit ``sherpa`` -> :class:`SherpaOnnxDiarizer`.
    3. explicit ``pyannote`` -> :class:`PyannoteDiarizer` (it self-degrades
       without a token/torch).
    4. ``auto`` -> pyannote when an HF token is configured; otherwise sherpa.

    The chosen backend still degrades gracefully on its own (e.g. sherpa skips
    when its models aren't downloaded yet, pyannote skips when torch/the token
    are unavailable) so the meeting always completes.
    """
    if fake_diarizer_enabled():
        return FakeDiarizer()
    if diarization_backend == "sherpa":
        return SherpaOnnxDiarizer()
    if diarization_backend == "pyannote":
        return PyannoteDiarizer()
    if hf_token:
        return PyannoteDiarizer()
    return SherpaOnnxDiarizer()


def _read_structured_transcript(meeting_id: str) -> list[TranscriptRecord]:
    """Read + parse the structured transcript (READ-ONLY) into ordered records.

    PREFERS the high-accuracy ``transcript.hifi.jsonl`` when a re-transcription
    pass produced one (so diarization aligns to + the index uses the better
    text); otherwise falls back to the live ``transcript.jsonl``. Returns ``[]``
    when neither exists or is empty. Skips malformed lines so a single bad line
    never aborts alignment.
    """
    hifi = hifi_jsonl_path(meeting_id)
    path = hifi if hifi.exists() else meeting_transcript_path(meeting_id, "structured")
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
    diarizer = diarizer or default_diarizer_factory(
        request.hf_token,
        request.diarization_backend,
    )
    selector = selector or _default_provider_selector
    reader = reader or FsTranscriptReader()

    diar_stage = "skipped"
    summary_stage = "skipped"
    speakers: list[str] = []
    diar_backend = ""
    summary_provider = ""
    summary_model = ""
    summary_title = ""
    index_parts: list[str] = []
    notes: list[str] = []

    # Kick DIARIZATION off NOW so it runs CONCURRENTLY with the re-transcription
    # below: the two stages are independent (diarization reads ONLY system.wav ->
    # speaker turns, and sherpa runs out-of-process), so overlapping them hides
    # the diarization wall time under the re-transcription long pole. ALIGNMENT
    # still waits for the hi-fi transcript (it needs the text). `emit` is
    # thread-safe and `diarizer.diarize` never emits, so jobUpdate ordering is
    # unaffected — we join the future in the diarization stage below.
    diar_pool: Optional[ThreadPoolExecutor] = None
    diar_future = None
    if not request.regenerate_summary:
        diar_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="diarize")
        diar_future = diar_pool.submit(
            diarizer.diarize, _system_wav_path(meeting_id), request.hf_token
        )

    # --- 0) HIGH-ACCURACY RE-TRANSCRIPTION (PRD-2 two-tier) --------------------
    # Runs BEFORE we read the structured transcript so diarization + the summary
    # + the search index all consume the better text. A larger model re-decodes
    # the recorded WAVs into transcript.hifi.{jsonl,md}; on skip/failure the live
    # transcript stands. Skipped for a summary-only regenerate.
    if request.re_transcribe and not request.regenerate_summary:
        rt_id = f"{meeting_id}:transcription"
        emit(
            JOB_UPDATE_EVENT,
            {"jobId": rt_id, "kind": JOB_KIND_TRANSCRIPTION, "state": "running", "progress": 0.0},
        )
        rt = re_transcribe_meeting(
            meeting_id,
            language=os.environ.get("LOQUI_TRANSCRIPTION_LANGUAGE") or None,
        )
        if rt.note:
            notes.append(rt.note)
        if rt.failed:
            emit(
                JOB_UPDATE_EVENT,
                {
                    "jobId": rt_id,
                    "kind": JOB_KIND_TRANSCRIPTION,
                    "state": "error",
                    "progress": 1.0,
                    "error": rt.note or "re-transcription failed",
                },
            )
        else:
            # produced=True (wrote hi-fi) or a benign skip (no audio / no speech):
            # the JOB completed either way; the outcome rides on the note.
            emit(
                JOB_UPDATE_EVENT,
                {"jobId": rt_id, "kind": JOB_KIND_TRANSCRIPTION, "state": "done", "progress": 1.0},
            )

    segments = _read_structured_transcript(meeting_id)

    # --- 1) DIARIZATION + 2) ALIGNMENT (skipped when regenerate-summary only) ---
    if not request.regenerate_summary:
        diar_id = f"{meeting_id}:diarization"
        emit(
            JOB_UPDATE_EVENT,
            {"jobId": diar_id, "kind": JOB_KIND_DIARIZATION, "state": "running", "progress": 0.0},
        )
        try:
            # Join the diarization started up front (ran in parallel with
            # re-transcription). `.result()` re-raises any worker exception here.
            assert diar_future is not None
            result = diar_future.result()
        except Exception:  # noqa: BLE001 - a backend crash degrades, never fatal.
            logger.exception("diarization backend crashed for %s", meeting_id)
            result = DiarizationResult(
                diarized=False,
                backend=getattr(diarizer, "name", ""),
                note="diarization failed unexpectedly",
            )
        finally:
            if diar_pool is not None:
                diar_pool.shutdown(wait=False)
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

        def _on_summary_delta(delta: str) -> None:
            # Forward each provider delta as a live ``summaryToken`` so the
            # renderer can stream the summary as it generates (the final parsed
            # summary.json is still the source of truth on the "done" jobUpdate).
            emit(
                SUMMARY_TOKEN_EVENT,
                {"jobId": sum_id, "meetingId": meeting_id, "delta": delta},
            )

        # Run under a hard timeout so a hung provider can't wedge the meeting in
        # "processing" forever. summarize() streams via on_delta (emit is
        # thread-safe), so running it on a worker thread is safe; on timeout we
        # stop waiting and finalize the meeting (the orphaned worker, if the
        # provider eventually returns, harmlessly drops its late deltas).
        summary_timeout = _resolved_summary_timeout()
        summary_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="summary")
        try:
            summary = summary_pool.submit(
                summarize,
                meeting_id,
                provider,
                config,
                api_key=request.api_key,
                reader=reader,
                on_delta=_on_summary_delta,
                context=request.meeting_context,
            ).result(timeout=summary_timeout)
        finally:
            summary_pool.shutdown(wait=False)
        summary.generated_at = datetime.now(timezone.utc).isoformat()
        from .writers import write_summary

        write_summary(summary)
        summary_stage = "done"
        summary_provider = summary.provider
        summary_model = summary.model
        summary_title = summary.title
        # Fold the summary into the searchable index. The default markdown summary
        # uses title + overview; the legacy fields are appended too (empty for the
        # markdown path) so a custom-template JSON summary still indexes fully.
        if summary.title:
            index_parts.append(summary.title)
        if summary.overview:
            index_parts.append(summary.overview)
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
    except FuturesTimeoutError:
        logger.warning("summary for %s timed out — finalizing without it", meeting_id)
        summary_stage = "error"
        notes.append("summary timed out")
        emit(
            JOB_UPDATE_EVENT,
            {
                "jobId": sum_id,
                "kind": JOB_KIND_SUMMARY,
                "state": "error",
                "progress": 1.0,
                "error": "summary timed out",
            },
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
            "title": summary_title,
            "indexText": " ".join(p for p in index_parts if p).strip(),
            "note": " ".join(notes).strip(),
        },
    )
