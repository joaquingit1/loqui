"""Runner: bind an ephemeral loopback port, print the handshake, serve, shut down.

Lifecycle:

1. Mint a random token and pick a free ``127.0.0.1`` port (ephemeral, OS-chosen).
2. Preload + compile the shared JSON Schemas (fail loudly before serving).
3. Print exactly one handshake line to stdout and flush it::

       {"port": <int>, "token": "<random>", "protocolVersion": "0.1.0"}

   The Electron main process reads that single line, then connects.
4. Serve the FastAPI app (uvicorn) until graceful shutdown is requested.

Shutdown is triggered by any of: a WS ``shutdown`` request, ``SIGTERM`` /
``SIGINT``, or parent-exit detection (stdin EOF, or the PID passed via
``--parent-pid`` no longer existing).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import signal
import socket
import sys
import threading
from dataclasses import dataclass

import uvicorn

from . import PROTOCOL_VERSION
from . import schemas
from .app import AppState, create_app

#: Bytes of entropy for the per-launch token (-> 43-char urlsafe string).
_TOKEN_BYTES = 32


@dataclass
class RunOptions:
    """Parsed runtime options."""

    parent_pid: int | None = None
    host: str = "127.0.0.1"
    version: str = "0.0.0"
    #: When True, do NOT watch stdin for EOF (tests drive shutdown explicitly).
    watch_stdin: bool = True


def parse_args(argv: list[str]) -> RunOptions:
    opts = RunOptions()
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--parent-pid":
            i += 1
            opts.parent_pid = int(argv[i])
        elif arg.startswith("--parent-pid="):
            opts.parent_pid = int(arg.split("=", 1)[1])
        elif arg == "--no-watch-stdin":
            opts.watch_stdin = False
        i += 1
    return opts


def _bind_ephemeral(host: str) -> socket.socket:
    """Bind a loopback socket on an OS-chosen port; return it ready to serve.

    Returning the bound socket (rather than just the port number) hands it
    straight to uvicorn, avoiding the race where the freed port is grabbed by
    another process between probing and binding.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, 0))
    sock.listen(128)
    sock.setblocking(False)
    return sock


def _print_handshake(port: int, token: str) -> None:
    line = json.dumps(
        {"port": port, "token": token, "protocolVersion": PROTOCOL_VERSION},
        separators=(",", ":"),
    )
    # Self-check: the handshake we emit must satisfy the shared contract.
    schemas.validate("Handshake", json.loads(line))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _watch_stdin_for_eof(loop: asyncio.AbstractEventLoop, on_exit) -> threading.Thread:
    """Trigger ``on_exit`` when stdin reaches EOF (parent process closed it)."""

    def run() -> None:
        try:
            while True:
                chunk = sys.stdin.buffer.read(4096)
                if chunk == b"":  # EOF -> parent gone.
                    break
        except (ValueError, OSError):
            return
        finally:
            loop.call_soon_threadsafe(on_exit)

    thread = threading.Thread(target=run, name="loqui-stdin-watch", daemon=True)
    thread.start()
    return thread


async def _watch_parent_pid(parent_pid: int, on_exit) -> None:
    """Poll for the parent PID; trigger ``on_exit`` once it is gone."""
    while True:
        await asyncio.sleep(1.0)
        if not _pid_alive(parent_pid):
            on_exit()
            return


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists but not ours to signal.
    return True


async def serve(
    opts: RunOptions, sock: socket.socket, state: AppState, port: int, token: str
) -> None:
    """Serve until shutdown is requested.

    Signal handlers are installed BEFORE the handshake line is printed, so the
    parent can SIGTERM us the instant it reads the port without racing the
    default disposition (which would kill us ungracefully).
    """
    loop = asyncio.get_running_loop()
    shutdown = asyncio.Event()
    state.shutdown_requested = shutdown

    app = create_app(state)
    config = uvicorn.Config(
        app,
        log_level="warning",
        # We own the lifecycle + signal handling; uvicorn must not install its own.
        lifespan="off",
    )
    server = uvicorn.Server(config)
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    def request_shutdown(*_args: object) -> None:
        if not shutdown.is_set():
            shutdown.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, ValueError):
            loop.add_signal_handler(sig, request_shutdown)

    # Handlers are armed: now it is safe to announce the port + serve.
    _print_handshake(port, token)

    if opts.watch_stdin:
        _watch_stdin_for_eof(loop, request_shutdown)
    if opts.parent_pid is not None:
        loop.create_task(_watch_parent_pid(opts.parent_pid, request_shutdown))

    serve_task = asyncio.create_task(server.serve(sockets=[sock]))
    await shutdown.wait()

    # Graceful drain: ask uvicorn to exit, then await the serve coroutine.
    server.should_exit = True
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(serve_task, timeout=5.0)
    if not serve_task.done():
        server.force_exit = True
        with contextlib.suppress(Exception):
            await serve_task


def run(argv: list[str] | None = None) -> int:
    """Synchronous entrypoint: set up, print handshake, serve. Returns exit code."""
    opts = parse_args(sys.argv[1:] if argv is None else argv)

    # Fail loudly BEFORE binding/printing if the schemas can't be loaded.
    schemas.preload()

    token = secrets.token_urlsafe(_TOKEN_BYTES)
    sock = _bind_ephemeral(opts.host)
    port = sock.getsockname()[1]
    state = AppState(token=token, version=opts.version)

    try:
        # The handshake is printed inside serve(), once signal handlers are armed.
        asyncio.run(serve(opts, sock, state, port, token))
    finally:
        with contextlib.suppress(OSError):
            sock.close()
    return 0
