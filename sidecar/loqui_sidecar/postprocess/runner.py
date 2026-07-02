"""run_postprocess (PRD-5) — the seam ``app.py``'s WS ``postProcess`` dispatch
calls. Orchestrates RE-TRANSCRIPTION + DIARIZATION + ALIGNMENT + SUMMARY,
emitting ``jobUpdate`` progress + a terminal ``postProcessDone``.

Flow (one ``postProcess`` notification -> ``jobUpdate``s, then one
``postProcessDone``)::

    app.py receives {type:"notification", event:"postProcess", data:{...}}
      -> run_postprocess(PostProcessRequest.from_wire(data), emit,
                         diarizer=..., selector=...)
      0) HI-FI RE-TRANSCRIPTION (PRD-2) — SKIPPED when the live transcript already
         holds accurate finals (the common recorded-meeting case), else re-decodes
         the WAVs -> transcript.hifi.*  (jobUpdate kind="transcription")
      1) DIARIZATION (system.wav only) via the DiarizationBackend
         -> emit jobUpdate(kind="diarization", running/done|error)
      2) ALIGNMENT (pure) over the READ-ONLY structured transcript (transcript.jsonl)
         -> write transcript.diarized.{json,md}
      3) SUMMARY via the PRD-4 provider (READ-ONLY) -> write summary.json
         -> emit jobUpdate(kind="summary", running/done|error)
      -> emit postProcessDone({meetingId, diarization, summary, speakers,
                               diarizationBackend, summaryProvider/Model, indexText, note})

For SPEED the summary runs CONCURRENTLY with diarization+alignment (it reads the
raw hi-fi/live transcript, never the diarized speaker labels, so it does not
depend on their output) — wall time is max(diarization, summary), not the sum.
Consequently the diarization + summary ``jobUpdate``s INTERLEAVE in a
timing-dependent order (each is still a clean running->done pair); only
``postProcessDone`` is guaranteed last. The renderer consumes jobUpdates per-kind
so the interleave is immaterial to the UI.

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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

from ..dedup import is_bleed_duplicate_env
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


def _filter_bleed_segments(
    segments: list[TranscriptRecord],
) -> tuple[list[TranscriptRecord], int]:
    """Drop MIC segments that are system-audio bleed (the AUTHORITATIVE cleanup).

    Loqui records mic ("You") + system ("They") streams; when the user plays the
    meeting audio on speakers the mic re-transcribes the remote speaker, producing
    a duplicate MIC segment wrongly attributed to "You". Bleed is one-way
    (system -> mic), so we only ever remove MIC segments, never system ones.

    Order-independent (we have the FULL transcript here, unlike the live ring
    buffer): each mic segment is compared against EVERY temporally-overlapping
    system segment, so one long system segment can cover several short mic bleed
    segments and vice versa. A mic segment is dropped if it is a bleed duplicate of
    ANY overlapping system segment. Returns the filtered records + the drop count.
    """
    system_segs = [s for s in segments if s.source == "system"]
    if not system_segs:
        return segments, 0
    kept: list[TranscriptRecord] = []
    suppressed = 0
    for seg in segments:
        if seg.source == "mic" and any(
            is_bleed_duplicate_env(
                seg.text,
                seg.t_start,
                seg.t_end,
                sys_seg.text,
                sys_seg.t_start,
                sys_seg.t_end,
            )
            for sys_seg in system_segs
        ):
            suppressed += 1
            continue
        kept.append(seg)
    return kept, suppressed


def _has_trustworthy_live_finals(segments: list[TranscriptRecord]) -> bool:
    """True when the live transcript already holds usable final segments.

    ``transcript.jsonl`` is written ONLY for ``status:"final"`` segments (the
    live pipeline commits accurate per-utterance finals during the meeting with
    the *accurate* backend — medium/beam-5), so ANY record with non-empty text
    means we already have a transcript at least as good as the post hi-fi pass
    (small/beam-3). We can then SKIP the redundant re-transcription and align +
    summarize over the live finals directly. Empty/whitespace-only records (e.g.
    a meeting where transcription produced nothing) do NOT count — those fall
    back to re-transcription."""
    return any(seg.text.strip() for seg in segments)


def _system_wav_path(meeting_id: str) -> str:
    """Absolute path to ``<id>/audio/system.wav`` (the "They" stream)."""
    # Resolve relative to the structured-transcript path so it honors LOQUI_DATA_DIR.
    meeting_dir = meeting_transcript_path(meeting_id, "structured").parent
    return str(meeting_dir / "audio" / "system.wav")


@dataclass
class _SummaryOutcome:
    """What the SUMMARY stage produced — collected off the summary worker thread
    (the stage runs CONCURRENTLY with diarization) so the main body can fold it
    into the terminal ``postProcessDone`` after joining."""

    stage: str = "skipped"
    provider: str = ""
    model: str = ""
    title: str = ""
    index_parts: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _run_summary_stage(
    request: PostProcessRequest,
    emit: PostProcessEmit,
    selector: ProviderSelector,
    reader: FsTranscriptReader,
) -> _SummaryOutcome:
    """Generate + persist the summary, emitting its ``jobUpdate``s (READ-ONLY).

    Self-contained + never-raising (every failure maps to a summary "error" +
    a jobUpdate), so it is safe to run on a worker thread CONCURRENTLY with
    diarization: the summary reads the raw hi-fi/live transcript (never the
    diarized speaker labels — see :func:`build_summary_messages`), so it does not
    depend on diarization output. Returns the outcome for the terminal payload.
    """
    meeting_id = request.meeting_id
    out = _SummaryOutcome()
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
        out.stage = "done"
        out.provider = summary.provider
        out.model = summary.model
        out.title = summary.title
        # Fold the summary into the searchable index. The default markdown summary
        # uses title + overview; the legacy fields are appended too (empty for the
        # markdown path) so a custom-template JSON summary still indexes fully.
        if summary.title:
            out.index_parts.append(summary.title)
        if summary.overview:
            out.index_parts.append(summary.overview)
        if summary.tldr:
            out.index_parts.append(summary.tldr)
        out.index_parts.extend(d for d in summary.decisions if d)
        for item in summary.action_items:
            if item.text:
                out.index_parts.append(f"{item.owner}: {item.text}" if item.owner else item.text)
        out.index_parts.extend(t for t in summary.topics if t)
        emit(
            JOB_UPDATE_EVENT,
            {"jobId": sum_id, "kind": JOB_KIND_SUMMARY, "state": "done", "progress": 1.0},
        )
    except FuturesTimeoutError:
        logger.warning("summary for %s timed out — finalizing without it", meeting_id)
        out.stage = "error"
        out.notes.append("summary timed out")
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
        out.stage = "error"
        out.notes.append(str(exc))
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
        out.stage = "error"
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
    return out


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
    speakers: list[str] = []
    diar_backend = ""
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
    # A larger model re-decodes the recorded WAVs into transcript.hifi.{jsonl,md}
    # so diarization + the summary + the search index all consume the better text.
    #
    # BUT: the LIVE pipeline already commits ACCURATE per-utterance finals during a
    # recorded meeting (the *accurate* backend — medium/beam-5 — writes them to
    # transcript.jsonl), which are AT LEAST as good as this post hi-fi pass
    # (small/beam-3) and often better. So when trustworthy live finals already
    # exist we SKIP the redundant, wall-time-dominating re-transcription entirely
    # and let alignment + the summary consume the live finals (via
    # _read_structured_transcript's fallback / the reader's precedence). The pass
    # STILL runs when: (a) there are NO usable live finals (e.g. a meeting whose
    # live transcription produced nothing — the hi-fi pass is then the only way to
    # get a transcript), and (b) the caller explicitly asked for it. Skipped for a
    # summary-only regenerate. (File imports never set re_transcribe — they decode
    # + transcribe the file up front in the importer, then reuse this for diarize +
    # summary only.)
    live_segments = _read_structured_transcript(meeting_id)
    if request.re_transcribe and not request.regenerate_summary:
        rt_id = f"{meeting_id}:transcription"
        emit(
            JOB_UPDATE_EVENT,
            {"jobId": rt_id, "kind": JOB_KIND_TRANSCRIPTION, "state": "running", "progress": 0.0},
        )
        if _has_trustworthy_live_finals(live_segments):
            # The live finals already stand as the accurate transcript — skip the
            # redundant re-transcription. The JOB still terminated OK ("done": the
            # shared jobStateSchema has no "skipped" state; the skip rides on the
            # note) so the UI never hangs on a phantom transcription stage.
            notes.append("re-transcription skipped: live transcript already accurate")
            emit(
                JOB_UPDATE_EVENT,
                {"jobId": rt_id, "kind": JOB_KIND_TRANSCRIPTION, "state": "done", "progress": 1.0},
            )
        else:
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
                # produced=True (wrote hi-fi) or a benign skip (no audio / no
                # speech): the JOB completed either way; the outcome rides on the
                # note.
                emit(
                    JOB_UPDATE_EVENT,
                    {
                        "jobId": rt_id,
                        "kind": JOB_KIND_TRANSCRIPTION,
                        "state": "done",
                        "progress": 1.0,
                    },
                )

    # Re-read AFTER re-transcription so alignment picks up transcript.hifi.jsonl
    # when the pass produced one (the reader PREFERS it); otherwise this is the
    # same live finals we read above (the common skip path re-reads harmlessly).
    segments = _read_structured_transcript(meeting_id)

    # AUTHORITATIVE speaker-bleed cleanup: remove MIC segments that duplicate any
    # temporally-overlapping SYSTEM segment (the remote speaker bled into the mic
    # when the user played meeting audio on speakers). Here we have the FULL
    # transcript, so this is order-independent + catches copies the best-effort
    # live ring buffer missed (e.g. a mic final that arrived before its system
    # twin). The filtered list feeds alignment -> a clean diarized transcript.
    segments, bleed_dropped = _filter_bleed_segments(segments)
    if bleed_dropped:
        notes.append(f"suppressed {bleed_dropped} mic segment(s) as system-audio bleed")

    # --- SUMMARY, started CONCURRENTLY with diarization ------------------------
    # The summary reads the RAW hi-fi/live transcript (never the diarized speaker
    # labels — build_summary_messages -> reader.read(..., "live")), so it does NOT
    # depend on diarization output and can run in parallel: wall time becomes
    # max(diarization, summary) instead of their sum. It starts only AFTER the
    # re-transcription decision above so it reads the hi-fi transcript when the
    # pass produced one. _run_summary_stage never raises + emits its own
    # jobUpdates (emit is thread-safe), so overlapping it with diarization is safe.
    summary_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="summary-stage")
    summary_future = summary_pool.submit(_run_summary_stage, request, emit, selector, reader)

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

    # --- 3) JOIN the concurrent SUMMARY ----------------------------------------
    # _run_summary_stage never raises (it maps every failure to a summary "error"),
    # so .result() here just collects the outcome + its own already-emitted
    # jobUpdates. The summary's index text + notes fold into the terminal payload.
    try:
        summary_out = summary_future.result()
    finally:
        summary_pool.shutdown(wait=False)
    index_parts.extend(summary_out.index_parts)
    notes.extend(summary_out.notes)

    # --- Terminal: hand main the data to index + finalize ----------------------
    emit(
        POSTPROCESS_DONE_EVENT,
        {
            "meetingId": meeting_id,
            "diarization": diar_stage,
            "summary": summary_out.stage,
            "speakers": speakers,
            "diarizationBackend": diar_backend,
            "summaryProvider": summary_out.provider,
            "summaryModel": summary_out.model,
            "title": summary_out.title,
            "indexText": " ".join(p for p in index_parts if p).strip(),
            "note": " ".join(notes).strip(),
        },
    )
