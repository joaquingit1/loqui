"""Tiny loopback HTTP + WS client helpers for the sidecar tests.

Uses only packages installed in the sidecar env (``urllib`` from stdlib and the
``websockets`` client). No ``httpx`` / ``requests`` dependency.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Any

import websockets


def http_get(url: str, timeout: float = 5.0) -> tuple[int, Any]:
    """GET ``url``; return ``(status_code, parsed_json_or_text)``.

    HTTP error responses (4xx/5xx) are returned as ``(code, body)`` rather than
    raising, so tests can assert on the status.
    """
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, _decode(resp.read(), resp.headers.get_content_type())
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return exc.code, _decode(body, exc.headers.get_content_type() if exc.headers else "")


def _decode(raw: bytes, content_type: str) -> Any:
    text = raw.decode("utf-8")
    if "json" in (content_type or ""):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return text


async def _ws_roundtrip(uri: str, sends: list[Any], recv_count: int, timeout: float) -> list[Any]:
    async with websockets.connect(uri, open_timeout=timeout) as ws:
        for payload in sends:
            if isinstance(payload, (bytes, bytearray)):
                await ws.send(payload)  # raw binary frame (PCM audio).
            elif isinstance(payload, str):
                await ws.send(payload)  # pre-serialized text.
            else:
                await ws.send(json.dumps(payload))
        out: list[Any] = []
        for _ in range(recv_count):
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            out.append(json.loads(raw) if isinstance(raw, str) else raw)
        return out


def ws_request(uri: str, sends: list[Any], recv_count: int = 1, timeout: float = 5.0) -> list[Any]:
    """Connect, send each payload, return the next ``recv_count`` JSON frames."""
    return asyncio.run(_ws_roundtrip(uri, sends, recv_count, timeout))


async def _ws_connect_fails(uri: str, timeout: float) -> Exception | None:
    try:
        async with websockets.connect(uri, open_timeout=timeout) as ws:
            # If the handshake somehow succeeded, try to read; a clean close is
            # also a rejection signal.
            try:
                await asyncio.wait_for(ws.recv(), timeout=1.0)
            except Exception as exc:  # noqa: BLE001 - capture any close/recv error
                return exc
        return None
    except Exception as exc:  # noqa: BLE001 - InvalidStatus / ConnectionClosed / etc.
        return exc


def ws_connect_rejected(uri: str, timeout: float = 5.0) -> bool:
    """Return True iff the WS handshake/connection is rejected (token auth fail)."""
    return asyncio.run(_ws_connect_fails(uri, timeout)) is not None
