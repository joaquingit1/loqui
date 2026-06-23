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

import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Header, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.status import HTTP_401_UNAUTHORIZED

from . import PROTOCOL_VERSION
from . import schemas

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


async def _serve_ws(state: AppState, websocket: WebSocket) -> None:
    """Receive + dispatch frames until the peer disconnects or shutdown fires."""
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
            # Binary frame = raw PCM audio (PRD-1). Accept + ignore for now.
            # (No response: audio frames are one-way notifications.)
    except WebSocketDisconnect:
        return
    except RuntimeError:
        # Starlette raises RuntimeError if we receive after a disconnect.
        return


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
