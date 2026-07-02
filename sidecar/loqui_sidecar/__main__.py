"""Console entrypoint for the Loqui sidecar (``loqui-sidecar``).

Binds 127.0.0.1 on an ephemeral port, prints the handshake line to stdout,
serves FastAPI + the WS control protocol (validating frames against the JSON
Schemas emitted by ``@loqui/shared``), and shuts down gracefully on SIGTERM /
parent-exit. The work lives in :mod:`loqui_sidecar.server`.

FROZEN ``-m`` DISPATCH (packaged-app crash-safety). In DEV, sys.executable is a
real Python and ``python -m loqui_sidecar.postprocess.sherpa_worker`` works. In
the PACKAGED PyInstaller app, sys.executable is the FROZEN binary, which does
NOT implement ``-m`` — so ``[sys.executable, "-m", <module>, …]`` (how
:mod:`loqui_sidecar.postprocess.sherpa_backend` isolates diarization) would boot
a SECOND full sidecar server that ignores argv, binds its own port, and blocks
forever on inherited stdin — wedging every diarization for the full worker
timeout. We EMULATE ``-m`` here: dispatch an allowlisted module by name, and
NEVER fall through to the server for an unknown ``-m`` target.
"""

from __future__ import annotations

import multiprocessing
import sys

from .server import run

#: Modules that may be launched as ``<binary> -m <module> [args…]`` in the frozen
#: app. Kept as an explicit allowlist so a stray ``-m`` can never boot the server
#: (or import an arbitrary module) — only the known crash-isolation worker routes.
_WORKER_MODULE = "loqui_sidecar.postprocess.sherpa_worker"


def _dispatch_frozen_module(argv: list[str]) -> int:
    """Emulate ``python -m <module> [args…]`` for the frozen binary.

    ``argv`` is ``sys.argv[2:]`` — i.e. ``[<module>, *module_args]``. Routes the
    allowlisted worker to its ``main`` with an argv shaped the way it expects
    (``sherpa_worker.main`` reads the JSON payload from ``argv[1]``), and errors
    out non-zero for anything else. NEVER runs the server.
    """
    if not argv:
        sys.stderr.write("loqui-sidecar: -m requires a module name\n")
        return 2
    module = argv[0]
    module_args = argv[1:]
    if module == _WORKER_MODULE:
        from .postprocess import sherpa_worker

        # sherpa_worker.main(argv) expects argv[1] = payload (argv[0] = prog).
        return sherpa_worker.main([module, *module_args])
    sys.stderr.write(f"loqui-sidecar: unknown -m module {module!r}\n")
    return 2


def main() -> int:
    """Entrypoint. Returns a process exit code."""
    # Required in frozen apps (harmless in dev); PyInstaller's runtime hook relies
    # on this for the multiprocessing children it spawns (e.g. resource_tracker).
    multiprocessing.freeze_support()

    # Emulate ``python -m <module>`` — the frozen binary is not a python and does
    # not implement ``-m`` itself, so the crash-isolation worker must be routed
    # here (never allowed to fall through to booting a second server).
    if sys.argv[1:2] == ["-m"]:
        return _dispatch_frozen_module(sys.argv[2:])

    # Plain (no ``-m``) launch: run the server exactly as before.
    return run()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
