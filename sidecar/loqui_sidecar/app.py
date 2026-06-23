"""FastAPI app + WebSocket control endpoint for the Loqui sidecar.

The app is intentionally a thin, well-typed shell around the WS control
protocol defined in ``@loqui/shared``:

* ``GET /health`` -> :class:`Health` JSON ``{status, version, protocolVersion, models}``.
* ``WS /ws`` -> JSON control envelopes (``ping`` / ``getHealth`` / ``shutdown``)
  validated against the emitted ``WsEnvelope`` schema, plus binary audio frames
  (accepted + ignored in PRD-0; the audio pipeline lands in PRD-1).

Every HTTP request and WS connection must present the per-launch auth token
(``?token=`` query param or ``X-Loqui-Token`` header / ``token`` subprotocol)
or it is rejected. The token + ephemeral port are minted by the runner
(:mod:`loqui_sidecar.server`) and passed in here.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Header, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.status import HTTP_401_UNAUTHORIZED

from . import PROTOCOL_VERSION
from . import schemas
from .audio_ingest import AUDIO_FRAME_SOURCE_BY_BYTE, _OFF_SOURCE, AudioIngest, default_ingest
from .transcription import (
    TranscriptionManager,
    default_transcription_manager,
    make_ws_emitter,
)

logger = logging.getLogger("loqui_sidecar.app")

#: HTTP header / WS subprotocol name carrying the auth token.
TOKEN_HEADER = "x-loqui-token"

#: WS close code used when a connection fails token auth (policy violation).
WS_CLOSE_POLICY_VIOLATION = 1008


@dataclass
class AppState:
    """Per-launch server state shared with route handlers."""

    token: str
    version: str = "0.0.0"
    #: Set by the runner; awaited to drive graceful shutdown.
    shutdown_requested: Any = None
    models: dict[str, str] = field(default_factory=dict)
    #: Audio-ingest sink (PRD-1). ``default_ingest()`` returns the real
    #: per-source WAV writer (writes ``<data_root>/meetings/<id>/audio/{mic,
    #: system}.wav``); a valid ``audioStart`` opens a writer, so spawn the
    #: sidecar with ``LOQUI_DATA_DIR`` pinned to a temp dir in tests/smokes.
    audio: AudioIngest = field(default_factory=default_ingest)
    #: Transcription engine (PRD-2). Subscribed (in ``__post_init__``) to the
    #: per-(meeting,source) decoded-PCM hook on ``audio`` as a ``FrameConsumer``,
    #: so it sees the same independent mic/system streams the WAV writer does.
    #: Foundation's default (fake backend + no-op pipeline + no emitter) is
    #: inert: it consumes PCM and emits NO ``transcriptSegment`` notifications
    #: until the PRD-2 build units inject the real pipeline + the WS emitter.
    transcription: TranscriptionManager = field(default_factory=default_transcription_manager)
    #: One single-thread executor PER audio source so the (CPU-bound, possibly
    #: slower-than-realtime) ASR decode that ``handle_binary_frame`` triggers runs
    #: OFF the asyncio event loop. This keeps the WS control channel (ping /
    #: getHealth / shutdown / audioStart-Stop) responsive during a decode, and —
    #: because mic and system get SEPARATE single-thread executors — a slow mic
    #: decode does not starve system-audio ingest (PRD-2 AC#3: both pipelines run
    #: without starving each other). Per-source single-threading preserves
    #: frame order within a source. Lazily created; closed by :meth:`close`.
    _frame_executors: dict[str, ThreadPoolExecutor] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Wire transcription as a consumer of the decoded-PCM stream alongside
        # the WAV writer. mic ("You") and system ("They") stay independent —
        # each (meeting, source) gets its own pipeline.
        self.audio.add_consumer(self.transcription)

    def frame_executor(self, source: str) -> ThreadPoolExecutor:
        """Return (creating on first use) the single-thread executor for ``source``."""
        ex = self._frame_executors.get(source)
        if ex is None:
            ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"audio-{source}")
            self._frame_executors[source] = ex
        return ex

    def close(self) -> None:
        """Release per-source decode executors (process-shutdown safety net)."""
        executors = list(self._frame_executors.values())
        self._frame_executors.clear()
        for ex in executors:
            ex.shutdown(wait=False, cancel_futures=True)

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "version": self.version,
            "protocolVersion": PROTOCOL_VERSION,
            "models": dict(self.models),
        }


def _token_ok(state: AppState, provided: str | None) -> bool:
    # Constant-time compare to avoid leaking the token via timing (loopback +
    # 256-bit token already make this negligible, but it costs nothing).
    return bool(provided) and secrets.compare_digest(provided, state.token)


def _make_response(req_id: str, result: Any) -> dict[str, Any]:
    return {"type": "response", "id": req_id, "ok": True, "result": result}


def _make_error(req_id: str | None, code: str, message: str) -> dict[str, Any]:
    return {
        "type": "error",
        "id": req_id,
        "ok": False,
        "error": {"code": code, "message": message},
    }


def create_app(state: AppState) -> FastAPI:
    """Build the FastAPI app bound to ``state`` (token, version, shutdown hook)."""

    # Disable the built-in docs/schema endpoints (/docs, /redoc, /openapi.json):
    # FastAPI serves them WITHOUT the per-launch token, which would otherwise be
    # an unauthenticated information-disclosure path that lets any local process
    # enumerate + fingerprint the API surface, contradicting this module's
    # token-on-every-request contract.
    app = FastAPI(
        title="loqui-sidecar",
        version=state.version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.loqui = state

    @app.get("/health")
    def health(
        token: str | None = Query(default=None),
        x_loqui_token: str | None = Header(default=None),
    ) -> JSONResponse:
        provided = token or x_loqui_token
        if not _token_ok(state, provided):
            return JSONResponse(
                {"error": {"code": "unauthorized", "message": "invalid or missing token"}},
                status_code=HTTP_401_UNAUTHORIZED,
            )
        return JSONResponse(state.health())

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        provided = websocket.query_params.get("token") or websocket.headers.get(TOKEN_HEADER)
        # Also accept the token offered as a WS subprotocol (browsers cannot set
        # arbitrary headers); echo it back on accept so the handshake succeeds.
        subprotocols = _requested_subprotocols(websocket)
        if provided is None and subprotocols:
            provided = subprotocols[0]

        if not _token_ok(state, provided):
            # Reject before completing the handshake.
            await websocket.close(code=WS_CLOSE_POLICY_VIOLATION)
            return

        accept_subprotocol = subprotocols[0] if subprotocols else None
        await websocket.accept(subprotocol=accept_subprotocol)
        await _serve_ws(state, websocket)

    return app


def _requested_subprotocols(websocket: WebSocket) -> list[str]:
    raw = websocket.headers.get("sec-websocket-protocol")
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def _install_transcript_emitter(state: AppState, websocket: WebSocket) -> None:
    """Wire the transcription engine's segment emitter to THIS live WS (PRD-2).

    Segments are produced from the audio-ingest call stack (sync), so the
    emitter schedules ``websocket.send_json`` onto the serving event loop
    thread-safely rather than awaiting inline. Best-effort: a closed/dropping
    socket is swallowed (the supervisor reconnects). Replaced/cleared on
    disconnect by :func:`_clear_transcript_emitter`.
    """
    loop = asyncio.get_running_loop()

    def send(event: str, data: dict) -> None:
        envelope = {"type": "notification", "event": event, "data": data}

        async def _send() -> None:
            try:
                await websocket.send_json(envelope)
            except Exception:  # noqa: BLE001 - a dropping socket must not crash transcription.
                pass

        try:
            loop.call_soon_threadsafe(lambda: loop.create_task(_send()))
        except RuntimeError:
            # Loop already closed (shutdown race): drop the segment.
            pass

    state.transcription.set_emitter(make_ws_emitter(send))


def _clear_transcript_emitter(state: AppState) -> None:
    """Reset the transcription emitter to inert on disconnect (no live socket)."""
    state.transcription.set_emitter(lambda _segment: None)


def _frame_source_byte(payload: bytes) -> str:
    """Peek the source byte off a binary audio frame header (cheap, no full decode).

    Returns the source name (``"mic"`` / ``"system"``) or ``"?"`` for an unknown /
    too-short frame — those route to a shared fallback executor (where
    ``handle_binary_frame`` drops them after a proper decode + log). Peeking here
    only picks the executor; the real validation/decode still happens in
    ``handle_binary_frame``.
    """
    if len(payload) <= _OFF_SOURCE:
        return "?"
    return AUDIO_FRAME_SOURCE_BY_BYTE.get(payload[_OFF_SOURCE], "?")


def _dispatch_binary_frame(state: AppState, payload: bytes) -> None:
    """Run ``handle_binary_frame`` on the source's worker thread (off the loop).

    The WS receive loop must not block on a CPU-bound ASR decode; offloading to a
    per-source single-thread executor keeps the control channel responsive and
    lets mic + system decode concurrently. Fire-and-forget: audio is best-effort
    and one-way, and ``handle_binary_frame`` never raises (it guards internally).
    """

    def _run() -> None:
        try:
            state.audio.handle_binary_frame(payload)
        except Exception:  # noqa: BLE001 - audio is best-effort, never fatal
            pass

    source = _frame_source_byte(payload)
    try:
        state.frame_executor(source).submit(_run)
    except RuntimeError:
        # Executor shut down (shutdown race): run inline as a last resort so a
        # late frame is still handled (and still cannot raise).
        _run()


async def _serve_ws(state: AppState, websocket: WebSocket) -> None:
    """Receive + dispatch frames until the peer disconnects or shutdown fires."""
    _install_transcript_emitter(state, websocket)
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            text = message.get("text")
            if text is not None:
                await _handle_text_frame(state, websocket, text)
                if state.shutdown_requested is not None and state.shutdown_requested.is_set():
                    # shutdown handler fired: response already sent; close cleanly.
                    await websocket.close()
                    return
                continue
            # Binary frame = raw PCM audio (PRD-1): 16-byte LE header + pcm_s16le.
            # Forward the raw bytes to the audio-ingest sink. One-way: no response.
            # handle_binary_frame fans out to the WAV writer AND the transcription
            # pipeline, whose ASR decode is CPU-bound and may be slower than
            # realtime. Running it inline here would block this single WS receive
            # loop — stalling ping/getHealth/shutdown and all audio ingest. So we
            # hand it to a PER-SOURCE single-thread executor (decode off the loop,
            # mic and system on separate threads so neither starves the other) and
            # keep receiving. ingest never raises; guard anyway.
            payload = message.get("bytes")
            if payload is not None:
                _dispatch_binary_frame(state, payload)
    except WebSocketDisconnect:
        return
    except RuntimeError:
        # Starlette raises RuntimeError if we receive after a disconnect.
        return
    finally:
        # The live socket is gone: stop the transcription engine from trying to
        # push segments onto a dead connection.
        _clear_transcript_emitter(state)


async def _handle_text_frame(state: AppState, websocket: WebSocket, text: str) -> None:
    import json

    try:
        frame = json.loads(text)
    except json.JSONDecodeError as exc:
        await websocket.send_json(_make_error(None, "invalid_json", f"malformed JSON: {exc}"))
        return

    # Validate the envelope shape against the shared contract schema.
    try:
        schemas.validate(schemas.WS_ENVELOPE, frame)
    except schemas.FrameValidationError as exc:
        req_id = frame.get("id") if isinstance(frame, dict) else None
        await websocket.send_json(
            _make_error(req_id, "invalid_frame", f"schema validation failed: {exc}")
        )
        return

    ftype = frame.get("type")
    if ftype == "notification":
        await _handle_notification(state, websocket, frame)
        return
    if ftype != "request":
        # response / error frames are server->client only; ignore inbound.
        return

    await _handle_request(state, websocket, frame)


async def _handle_request(state: AppState, websocket: WebSocket, frame: dict[str, Any]) -> None:
    req_id = frame["id"]
    method = frame["method"]

    if method == "ping":
        await websocket.send_json(_make_response(req_id, {"pong": True, "ts": time.time()}))
    elif method == "getHealth":
        await websocket.send_json(_make_response(req_id, state.health()))
    elif method == "shutdown":
        await websocket.send_json(_make_response(req_id, {"shuttingDown": True}))
        if state.shutdown_requested is not None:
            state.shutdown_requested.set()
    else:  # pragma: no cover - schema enum already constrains method
        await websocket.send_json(
            _make_error(req_id, "unknown_method", f"unknown method: {method!r}")
        )


async def _handle_notification(
    state: AppState, websocket: WebSocket, frame: dict[str, Any]
) -> None:
    """Handle inbound notifications (audio control frames).

    ``audioStart`` / ``audioStop`` carry their payload in ``data`` and are
    validated against the matching schema. PRD-0 only validates + acks the
    shape; the audio pipeline consumes them in PRD-1. Unknown events are
    ignored (forward-compatible).
    """
    event = frame.get("event")
    data = frame.get("data")
    schema_name = {"audioStart": schemas.AUDIO_START, "audioStop": schemas.AUDIO_STOP}.get(event)
    if schema_name is None:
        return  # unknown notification: accept + ignore.
    try:
        schemas.validate(schema_name, data)
    except schemas.FrameValidationError as exc:
        await websocket.send_json(
            _make_error(None, "invalid_frame", f"{event} validation failed: {exc}")
        )
        return

    # Valid control frame: drive the per-source audio-ingest lifecycle (PRD-1).
    # data is the validated AudioStart/AudioStop: {meetingId, source, ...}.
    if not isinstance(data, dict):
        return
    meeting_id = data.get("meetingId")
    source = data.get("source")
    if not isinstance(meeting_id, str) or not isinstance(source, str):
        return

    # Run start/stop on the SAME per-source executor the binary frames use, so the
    # lifecycle stays correctly ordered with the frame stream: audioStart opens
    # the pipeline before its frames decode, and audioStop's flush
    # (``pipeline.finish``) runs AFTER every already-queued frame for that source
    # has been processed — never racing ahead of in-flight decodes. Keeping the
    # FIFO single-thread executor is what makes this ordering hold.
    def _lifecycle() -> None:
        try:
            if event == "audioStart":
                state.audio.handle_audio_start(meeting_id, source)
            else:  # audioStop
                state.audio.handle_audio_stop(meeting_id, source)
        except Exception:  # noqa: BLE001 - ingest must never break the control channel
            pass

    try:
        state.frame_executor(source).submit(_lifecycle)
    except RuntimeError:
        _lifecycle()  # executor shut down (shutdown race): run inline.
