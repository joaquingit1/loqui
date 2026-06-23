"""End-to-end tests against a real spawned sidecar process.

Covers the handshake contract, ephemeral loopback binding, token enforcement
on HTTP + WS, the WS control handlers (ping/pong, getHealth, shutdown), and
schema accept/reject of inbound frames.
"""

from __future__ import annotations

import sys
import uuid

import pytest

from loqui_sidecar import PROTOCOL_VERSION

from . import _client

# --- Handshake -----------------------------------------------------------------


def test_handshake_shape_and_protocol_version(sidecar):
    assert isinstance(sidecar.port, int) and sidecar.port > 0
    assert isinstance(sidecar.token, str) and len(sidecar.token) >= 16
    assert sidecar.protocol_version == PROTOCOL_VERSION


def test_handshake_validates_against_handshake_schema(sidecar):
    from loqui_sidecar import schemas

    schemas.validate(
        "Handshake",
        {
            "port": sidecar.port,
            "token": sidecar.token,
            "protocolVersion": sidecar.protocol_version,
        },
    )


# --- HTTP /health + token enforcement -----------------------------------------


def test_health_ok_with_token(sidecar):
    status, body = _client.http_get(f"{sidecar.base_url}/health?token={sidecar.token}")
    assert status == 200
    assert body["status"] == "ok"
    assert body["protocolVersion"] == PROTOCOL_VERSION
    assert body["models"] == {}
    assert "version" in body


def test_health_rejects_missing_token(sidecar):
    status, _body = _client.http_get(f"{sidecar.base_url}/health")
    assert status == 401


def test_health_rejects_wrong_token(sidecar):
    status, _body = _client.http_get(f"{sidecar.base_url}/health?token=not-the-token")
    assert status == 401


def test_binds_loopback_only(sidecar):
    # The handshake port is reachable on 127.0.0.1; that's where we bound.
    status, _ = _client.http_get(f"http://127.0.0.1:{sidecar.port}/health?token={sidecar.token}")
    assert status == 200


# --- WS token enforcement ------------------------------------------------------


def test_ws_rejects_without_token(sidecar):
    assert _client.ws_connect_rejected(sidecar.ws_url)


def test_ws_rejects_wrong_token(sidecar):
    assert _client.ws_connect_rejected(f"{sidecar.ws_url}?token=wrong")


def _authed_ws(sidecar) -> str:
    return f"{sidecar.ws_url}?token={sidecar.token}"


# --- WS control handlers -------------------------------------------------------


def test_ws_ping_pong(sidecar):
    [resp] = _client.ws_request(
        _authed_ws(sidecar), [{"type": "request", "id": "1", "method": "ping"}]
    )
    assert resp["type"] == "response"
    assert resp["id"] == "1"
    assert resp["ok"] is True
    assert resp["result"]["pong"] is True
    assert isinstance(resp["result"]["ts"], (int, float))


def test_ws_get_health(sidecar):
    [resp] = _client.ws_request(
        _authed_ws(sidecar), [{"type": "request", "id": "h", "method": "getHealth"}]
    )
    assert resp["ok"] is True
    assert resp["result"]["status"] == "ok"
    assert resp["result"]["protocolVersion"] == PROTOCOL_VERSION


def test_ws_rejects_invalid_frame(sidecar):
    [resp] = _client.ws_request(
        _authed_ws(sidecar), [{"type": "request", "id": "bad", "method": "fly"}]
    )
    assert resp["type"] == "error"
    assert resp["ok"] is False
    assert resp["id"] == "bad"
    assert resp["error"]["code"] == "invalid_frame"


def test_ws_rejects_malformed_json(sidecar):
    [resp] = _client.ws_request(_authed_ws(sidecar), ["{not json"])
    assert resp["type"] == "error"
    assert resp["error"]["code"] == "invalid_json"


def test_ws_accepts_valid_audio_notification(sidecar):
    # A well-formed audioStart notification is accepted silently (no error
    # frame). We send it, then a ping; the only response we get back is the pong.
    [resp] = _client.ws_request(
        _authed_ws(sidecar),
        [
            {
                "type": "notification",
                "event": "audioStart",
                "data": {"meetingId": str(uuid.uuid4()), "source": "mic"},
            },
            {"type": "request", "id": "after", "method": "ping"},
        ],
        recv_count=1,
    )
    assert resp["id"] == "after"
    assert resp["result"]["pong"] is True


def test_ws_rejects_invalid_audio_notification(sidecar):
    [resp] = _client.ws_request(
        _authed_ws(sidecar),
        [
            {
                "type": "notification",
                "event": "audioStart",
                "data": {"source": "ghost"},  # missing meetingId + bad source
            }
        ],
    )
    assert resp["type"] == "error"
    assert resp["error"]["code"] == "invalid_frame"


def test_ws_accepts_binary_audio_frame(sidecar):
    # 16-byte LE header (magic 0xA0, source mic=0, seq, ts) + a little PCM.
    header = bytes([0xA0, 0x00]) + b"\x00" * 14
    pcm = b"\x01\x02" * 8
    [resp] = _client.ws_request(
        _authed_ws(sidecar),
        [header + pcm, {"type": "request", "id": "post-bin", "method": "ping"}],
        recv_count=1,
    )
    assert resp["id"] == "post-bin"  # binary frame consumed without error.


# --- Graceful shutdown ---------------------------------------------------------


def test_ws_shutdown_acks_and_exits(sidecar):
    [resp] = _client.ws_request(
        _authed_ws(sidecar), [{"type": "request", "id": "sd", "method": "shutdown"}]
    )
    assert resp["ok"] is True
    assert resp["result"]["shuttingDown"] is True
    assert sidecar.proc.wait(timeout=8) == 0


@pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "SIGTERM is not a catchable graceful-shutdown signal on Windows "
        "(subprocess.terminate() maps to TerminateProcess -> exit code 1). "
        "stdin-EOF (test_stdin_eof_shuts_down) is the cross-platform graceful path."
    ),
)
def test_sigterm_shuts_down_gracefully(sidecar):
    import signal

    sidecar.proc.send_signal(signal.SIGTERM)
    assert sidecar.proc.wait(timeout=8) == 0


def test_stdin_eof_shuts_down(spawn_sidecar):
    # Default (stdin-watching enabled): closing stdin signals parent exit.
    handle = spawn_sidecar()  # no --no-watch-stdin
    handle.proc.stdin.close()
    assert handle.proc.wait(timeout=8) == 0


def test_parent_pid_death_shuts_down(spawn_sidecar):
    import subprocess
    import sys

    sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        handle = spawn_sidecar("--no-watch-stdin", "--parent-pid", str(sleeper.pid))
        sleeper.kill()
        sleeper.wait(timeout=5)
        assert handle.proc.wait(timeout=8) == 0
    finally:
        if sleeper.poll() is None:
            sleeper.kill()


def test_two_sidecars_get_distinct_ports_and_tokens(spawn_sidecar):
    a = spawn_sidecar("--no-watch-stdin")
    b = spawn_sidecar("--no-watch-stdin")
    assert a.port != b.port
    assert a.token != b.token
    # A's token must not authenticate against B.
    status, _ = _client.http_get(f"{b.base_url}/health?token={a.token}")
    assert status == 401
