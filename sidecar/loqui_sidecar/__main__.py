"""Console entrypoint for the Loqui sidecar (``loqui-sidecar``).

Binds 127.0.0.1 on an ephemeral port, prints the handshake line to stdout,
serves FastAPI + the WS control protocol (validating frames against the JSON
Schemas emitted by ``@loqui/shared``), and shuts down gracefully on SIGTERM /
parent-exit. The work lives in :mod:`loqui_sidecar.server`.
"""

from __future__ import annotations

import sys

from .server import run


def main() -> int:
    """Entrypoint. Returns a process exit code."""
    return run()


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
