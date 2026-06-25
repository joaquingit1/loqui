"""Hermetic test fixtures for the Loqui sidecar.

The sidecar tests spawn the *real* ``loqui-sidecar`` process (so the handshake,
ephemeral-port binding, token enforcement, and graceful-shutdown paths are
exercised end-to-end) and talk to it over loopback. ``httpx`` / Starlette's
``TestClient`` is intentionally not used (it is not installed in the sidecar
env), and the subprocess approach is a stronger integration test anyway.

Hermeticity: every spawned process gets ``LOQUI_DATA_DIR`` pointed at a temp
dir so nothing can touch the real ``~/Loqui``. The sidecar binds only to
127.0.0.1 on an OS-chosen ephemeral port.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass

import pytest

# Keep the default unit gate HERMETIC + OFFLINE: force the FAKE ASR backend for
# every test (in-process and every spawned sidecar) so nothing downloads a model
# or runs real inference. The opt-in real-model smoke
# (tests/test_asr_real_model.py) constructs FasterWhisperBackend directly and is
# unaffected by this flag. Set before any sidecar import / spawn.
os.environ.setdefault("LOQUI_FAKE_ASR", "1")
os.environ.setdefault("LOQUI_NO_MODEL_DOWNLOAD", "1")


@dataclass
class SidecarHandle:
    """A running sidecar subprocess + its handshake details."""

    proc: subprocess.Popen
    port: int
    token: str
    protocol_version: str

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def ws_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/ws"


def _spawn(extra_args: list[str], tmp_path) -> subprocess.Popen:
    env = dict(os.environ)
    env["LOQUI_DATA_DIR"] = str(tmp_path)  # hermetic: never the real ~/Loqui.
    return subprocess.Popen(
        [sys.executable, "-m", "loqui_sidecar", *extra_args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def _read_handshake(proc: subprocess.Popen, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    line = ""
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if line:
            break
        if proc.poll() is not None:
            stderr = proc.stderr.read()
            raise RuntimeError(f"sidecar exited before handshake (rc={proc.returncode}):\n{stderr}")
        time.sleep(0.02)
    if not line:
        raise RuntimeError("timed out waiting for sidecar handshake line")
    return json.loads(line)


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=8)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            proc.kill()
            proc.wait(timeout=5)


@pytest.fixture
def spawn_sidecar(tmp_path):
    """Factory fixture: start a sidecar (optionally with extra CLI args).

    Returns a callable ``spawn(*args) -> SidecarHandle``. All spawned processes
    are torn down (SIGTERM, then kill) at the end of the test.
    """
    procs: list[subprocess.Popen] = []

    def spawn(*extra_args: str) -> SidecarHandle:
        proc = _spawn(list(extra_args), tmp_path)
        procs.append(proc)
        hs = _read_handshake(proc)
        return SidecarHandle(
            proc=proc,
            port=hs["port"],
            token=hs["token"],
            protocol_version=hs["protocolVersion"],
        )

    yield spawn

    for proc in procs:
        _terminate(proc)


@pytest.fixture
def sidecar(spawn_sidecar) -> SidecarHandle:
    """A single running sidecar with stdin-watching disabled (test-driven)."""
    return spawn_sidecar("--no-watch-stdin")
