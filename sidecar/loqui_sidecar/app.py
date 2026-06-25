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
from collections.abc import Callable
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


def _default_chat_handler(
    data: dict[str, Any], emit: Callable[[str, dict[str, Any]], None]
) -> None:
    """Default chat handler (PRD-4): decode the ``chatRequest`` ``data`` and run
    :func:`loqui_sidecar.providers.handle_chat`, streaming via ``emit``.

    Imports the providers package lazily so the chat dependency surface
    (``anthropic`` / ``httpx``, pulled by the build units) is not imported at app
    startup. Wires the PRODUCTION selector (:func:`build_selector`) so the REAL
    Anthropic / Ollama / agent-CLI providers are used in production; the selector
    still forces the hermetic ``FakeChatProvider`` when ``LOQUI_FAKE_CHAT`` is set
    or ``providerConfig.provider == "fake"`` (so tests/smoke stay offline and need
    no key/CLI). The heavy provider deps are lazy-imported by ``build_selector``
    only when a real provider is actually constructed, so importing here stays
    light. Never raises (handle_chat guards internally).
    """
    from .providers import ChatRequest, build_selector, handle_chat

    handle_chat(ChatRequest.from_wire(data), emit, selector=build_selector())


def _default_postprocess_handler(
    data: dict[str, Any], emit: Callable[[str, dict[str, Any]], None]
) -> None:
    """Default post-processing handler (PRD-5): decode the ``postProcess`` ``data``
    and run :func:`loqui_sidecar.postprocess.run_postprocess` (diarization +
    alignment + summary), streaming ``jobUpdate`` progress + a terminal
    ``postProcessDone`` via ``emit``.

    Imports the postprocess package lazily so its (optional) diarization surface
    is never imported at app startup. Wires the PRODUCTION provider selector for
    the summary step (the same PRD-4 selector chat uses, so ``LOQUI_FAKE_CHAT``
    still forces the fake provider in tests). The diarizer defaults to the fake
    diarizer when ``LOQUI_FAKE_DIARIZER`` is set, else the real PyannoteDiarizer
    (which degrades gracefully when torch/pyannote/the HF token are absent). Never
    raises (run_postprocess guards internally). NEVER logs the api/hf token.
    """
    from .postprocess import PostProcessRequest, run_postprocess
    from .providers import build_selector

    run_postprocess(PostProcessRequest.from_wire(data), emit, selector=build_selector())


def _default_import_handler(
    data: dict[str, Any], emit: Callable[[str, dict[str, Any]], None]
) -> None:
    """Default file-import handler (PRD-12): decode the ``importFile`` ``data``
    and run :func:`loqui_sidecar.file_import.run_import` (decode -> the EXISTING
    transcription engine -> the EXISTING diarization + summary), streaming
    ``jobUpdate`` progress + a terminal ``importFileDone`` via ``emit``.

    Imports the file_import + providers packages lazily so PyAV (``av``) and the
    provider/diarization deps are not imported at app startup. Wires the PRODUCTION
    provider selector for the reused summary step (so ``LOQUI_FAKE_CHAT`` still
    forces the fake provider in tests). Never raises (run_import guards
    internally). NEVER logs the api/hf token.
    """
    from .file_import import run_import
    from .file_import.importer import ImportFileRequest
    from .providers import build_selector

    run_import(ImportFileRequest.from_wire(data), emit, selector=build_selector())


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
    #: Server->client notification sender, bound to the live WS by
    #: ``_install_transcript_emitter`` (reset to a no-op on disconnect). Used to
    #: emit ``audioFinalized`` once a source's WAV is flushed + closed, giving the
    #: parent a DETERMINISTIC finalize signal (so it never reads a 0-byte / still
    #: open WAV after ``audioStop`` — and so PRD-5 diarization can safely read it).
    #: Thread-safe: the closure schedules the send onto the serving loop.
    notify: Callable[[str, dict[str, Any]], None] = field(default=lambda _event, _data: None)
    #: Chat handler entry point (PRD-4). Called for each inbound ``chatRequest``
    #: notification with the decoded ``data`` dict + an ``emit(event, data)`` bound
    #: to the live WS sender (``notify``); it reads the meeting transcript
    #: READ-ONLY, selects a provider, and streams ``chatToken``/``chatDone``/
    #: ``chatError`` notifications. Defaulted to the real :func:`handle_chat`
    #: wrapper (fake-only selector at Foundation; build units inject the real
    #: providers via a selector). Injectable so tests can stub it. Run OFF the WS
    #: receive loop (a provider call blocks) on the chat executor.
    chat_handler: Callable[[dict[str, Any], Callable[[str, dict[str, Any]], None]], None] = field(
        default=_default_chat_handler
    )
    #: Post-processing handler entry point (PRD-5). Called for each inbound
    #: ``postProcess`` notification with the decoded ``data`` dict + an
    #: ``emit(event, data)`` bound to the live WS sender (``notify``); it runs
    #: diarization (on ``<id>/audio/system.wav``) + alignment + the AI summary
    #: (reusing the PRD-4 provider READ-ONLY), streaming ``jobUpdate`` progress +
    #: a terminal ``postProcessDone``. Defaulted to the real
    #: :func:`run_postprocess` wrapper. Injectable so tests can stub it. Run OFF
    #: the WS receive loop (diarization + a provider call block) on the
    #: postprocess executor. The handler never edits the transcript (it writes
    #: only the derived diarized + summary files).
    postprocess_handler: Callable[[dict[str, Any], Callable[[str, dict[str, Any]], None]], None] = (
        field(default=_default_postprocess_handler)
    )
    #: File-import handler entry point (PRD-12). Called for each inbound
    #: ``importFile`` notification with the decoded ``data`` dict + an
    #: ``emit(event, data)`` bound to the live WS sender (``notify``); it decodes
    #: the file, runs the EXISTING transcription engine + the EXISTING diarization
    #: + summary (no forked pipeline), streaming ``jobUpdate`` progress + a
    #: terminal ``importFileDone``. Defaulted to the real :func:`run_import`
    #: wrapper. Injectable so tests can stub it. Run OFF the WS receive loop (the
    #: decode + ASR + a provider call block) on the postprocess executor — file
    #: import is a long-running, offline job just like post-processing.
    import_handler: Callable[[dict[str, Any], Callable[[str, dict[str, Any]], None]], None] = field(
        default=_default_import_handler
    )
    #: Single-thread executor for chat requests so a slow/streaming provider call
    #: never blocks the WS control channel. Lazily created; closed by ``close``.
    _chat_executor: Any = None
    #: Single-thread executor for post-processing (PRD-5) so the long-running
    #: diarization + summary job never blocks the WS control channel (or chat).
    #: Lazily created; closed by ``close``.
    _postprocess_executor: Any = None

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

    def chat_executor(self) -> ThreadPoolExecutor:
        """Return (creating on first use) the single-thread chat executor (PRD-4).

        Chat runs OFF the WS receive loop so a slow/streaming provider call never
        stalls ping/getHealth/shutdown or audio ingest. Single-threaded so
        concurrent chats queue rather than fan out unbounded; ``emit`` is
        thread-safe (schedules onto the serving loop).
        """
        if self._chat_executor is None:
            self._chat_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="chat")
        return self._chat_executor

    def postprocess_executor(self) -> ThreadPoolExecutor:
        """Return (creating on first use) the single-thread post-processing executor (PRD-5).

        Diarization + summary are long-running and run OFF the WS receive loop so
        they never stall ping/getHealth/shutdown, audio ingest, or chat.
        Single-threaded so concurrent post-process requests queue rather than fan
        out unbounded; ``emit`` is thread-safe (schedules onto the serving loop).
        """
        if self._postprocess_executor is None:
            self._postprocess_executor = ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="postprocess"
            )
        return self._postprocess_executor

    def close(self) -> None:
        """Release per-source decode + chat + postprocess executors (shutdown safety net)."""
        executors = list(self._frame_executors.values())
        self._frame_executors.clear()
        if self._chat_executor is not None:
            executors.append(self._chat_executor)
            self._chat_executor = None
        if self._postprocess_executor is not None:
            executors.append(self._postprocess_executor)
            self._postprocess_executor = None
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
    # Also expose the sender for non-transcript notifications (e.g. audioFinalized).
    state.notify = send


def _clear_transcript_emitter(state: AppState) -> None:
    """Reset the transcription emitter to inert on disconnect (no live socket)."""
    state.transcription.set_emitter(lambda _segment: None)
    state.notify = lambda _event, _data: None


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
            logger.exception("handle_binary_frame failed")

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


async def _handle_chat_request(state: AppState, websocket: WebSocket, data: Any) -> None:
    """Validate + dispatch one ``chatRequest`` notification (PRD-4).

    Validates ``data`` against the emitted ``ChatRequest`` schema, then runs the
    chat handler on the single-thread chat executor (OFF the WS receive loop) so a
    slow/streaming provider call cannot stall the control channel. The handler
    streams ``chatToken``/``chatDone``/``chatError`` notifications via
    ``state.notify`` (the thread-safe per-connection sender), so a dropped socket
    simply no-ops the emits. The handler never raises (it guards internally); the
    submit is guarded too. NEVER logs the api key (it lives only in ``data`` and
    is consumed transiently by the provider).
    """
    try:
        schemas.validate(schemas.CHAT_REQUEST, data)
    except schemas.FrameValidationError as exc:
        await websocket.send_json(
            _make_error(None, "invalid_frame", f"chatRequest validation failed: {exc}")
        )
        return
    if not isinstance(data, dict):
        return

    # Snapshot the live sender so the worker emits onto THIS connection (reset to
    # a no-op on disconnect, which harmlessly drops late chat tokens).
    emit = state.notify
    handler = state.chat_handler

    def _run() -> None:
        try:
            handler(data, emit)
        except Exception:  # noqa: BLE001 - chat must never break the control channel.
            logger.exception("chat handler crashed")

    try:
        state.chat_executor().submit(_run)
    except RuntimeError:
        # Executor shut down (shutdown race): run inline as a last resort.
        _run()


async def _handle_postprocess_request(state: AppState, websocket: WebSocket, data: Any) -> None:
    """Validate + dispatch one ``postProcess`` notification (PRD-5).

    Validates ``data`` against the emitted ``PostProcessRequest`` schema, then
    runs the post-processing handler on the single-thread postprocess executor
    (OFF the WS receive loop) so the long-running diarization + summary job never
    stalls the control channel. The handler streams ``jobUpdate`` progress + a
    terminal ``postProcessDone`` via ``state.notify`` (the thread-safe
    per-connection sender), so a dropped socket simply no-ops the emits. The
    handler never raises (it guards internally); the submit is guarded too. NEVER
    logs the api/hf token (they live only in ``data`` and are consumed transiently).
    """
    try:
        schemas.validate(schemas.POSTPROCESS_REQUEST, data)
    except schemas.FrameValidationError as exc:
        await websocket.send_json(
            _make_error(None, "invalid_frame", f"postProcess validation failed: {exc}")
        )
        return
    if not isinstance(data, dict):
        return

    # Snapshot the live sender so the worker emits onto THIS connection (reset to
    # a no-op on disconnect, which harmlessly drops late job updates).
    emit = state.notify
    handler = state.postprocess_handler

    def _run() -> None:
        try:
            handler(data, emit)
        except Exception:  # noqa: BLE001 - postprocess must never break the control channel.
            logger.exception("postprocess handler crashed")

    try:
        state.postprocess_executor().submit(_run)
    except RuntimeError:
        # Executor shut down (shutdown race): run inline as a last resort.
        _run()


async def _handle_import_request(state: AppState, websocket: WebSocket, data: Any) -> None:
    """Validate + dispatch one ``importFile`` notification (PRD-12).

    Validates ``data`` against the emitted ``ImportFileRequest`` schema, then runs
    the import handler on the single-thread postprocess executor (OFF the WS
    receive loop) so the long-running decode + transcription + diarization +
    summary never stalls the control channel. The handler streams ``jobUpdate``
    progress + a terminal ``importFileDone`` via ``state.notify`` (the thread-safe
    per-connection sender), so a dropped socket simply no-ops the emits. The
    handler never raises (it guards internally); the submit is guarded too. NEVER
    logs the api/hf token (they live only in ``data`` and are consumed transiently).
    """
    try:
        schemas.validate(schemas.IMPORT_FILE_REQUEST, data)
    except schemas.FrameValidationError as exc:
        await websocket.send_json(
            _make_error(None, "invalid_frame", f"importFile validation failed: {exc}")
        )
        return
    if not isinstance(data, dict):
        return

    emit = state.notify
    handler = state.import_handler

    def _run() -> None:
        try:
            handler(data, emit)
        except Exception:  # noqa: BLE001 - import must never break the control channel.
            logger.exception("import handler crashed")

    try:
        state.postprocess_executor().submit(_run)
    except RuntimeError:
        # Executor shut down (shutdown race): run inline as a last resort.
        _run()


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

    # AI chat (PRD-4): a `chatRequest` notification (main -> sidecar) begins a
    # streaming chat completion. It is validated against the emitted ChatRequest
    # schema, then dispatched to the chat handler on the chat executor (OFF this
    # receive loop — a provider call blocks). The handler streams chatToken /
    # chatDone / chatError notifications back via the live WS sender. Runs the
    # handler with `state.notify` so a dropped socket simply no-ops the emit.
    if event == "chatRequest":
        await _handle_chat_request(state, websocket, data)
        return

    # Post-processing (PRD-5): a `postProcess` notification (main -> sidecar)
    # begins the diarization + alignment + summary pipeline. Validated against the
    # emitted PostProcessRequest schema, then dispatched to the postprocess handler
    # on the postprocess executor (OFF this receive loop — diarization + a provider
    # call block). The handler streams jobUpdate + postProcessDone notifications
    # back via the live WS sender.
    if event == "postProcess":
        await _handle_postprocess_request(state, websocket, data)
        return

    # File import (PRD-12): an `importFile` notification (main -> sidecar) begins
    # the decode + transcription + diarization + summary pipeline for an existing
    # media file. Validated against the emitted ImportFileRequest schema, then
    # dispatched to the import handler on the postprocess executor (OFF this
    # receive loop — the decode + a provider call block). The handler streams
    # jobUpdate + importFileDone notifications back via the live WS sender.
    if event == "importFile":
        await _handle_import_request(state, websocket, data)
        return

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
    # PRD-13 audio-retention: `never-save` sends persistAudio=false so the WAV
    # writer skips disk persistence (transcription still streams). Defaulted true
    # so an older main that omits the field keeps writing the WAVs.
    persist_audio = data.get("persistAudio", True)
    if not isinstance(persist_audio, bool):
        persist_audio = True

    def _lifecycle() -> None:
        try:
            if event == "audioStart":
                state.audio.handle_audio_start(meeting_id, source, persist=persist_audio)
            else:  # audioStop
                # Runs on the per-source FIFO executor, so by the time this
                # returns every queued frame for the source has been written and
                # the WAV is flushed + closed. Only THEN announce finalization, so
                # the parent never reads a 0-byte / still-open WAV (Windows) and
                # PRD-5 diarization can safely read <id>/audio/<source>.wav.
                state.audio.handle_audio_stop(meeting_id, source)
                state.notify("audioFinalized", {"meetingId": meeting_id, "source": source})
        except Exception:  # noqa: BLE001 - ingest must never break the control channel
            logger.exception("audio %s lifecycle failed (%s/%s)", event, meeting_id, source)

    try:
        state.frame_executor(source).submit(_lifecycle)
    except RuntimeError:
        _lifecycle()  # executor shut down (shutdown race): run inline.
