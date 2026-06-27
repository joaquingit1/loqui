"""PyInstaller entry point for the bundled sidecar.

Running ``loqui_sidecar/__main__.py`` directly as a script (as PyInstaller did)
breaks its package-relative imports (``from .server import run`` →
"attempted relative import with no known parent package") AND breaks PyInstaller's
dependency analysis (it can't import the package, so it misses ctranslate2 /
faster-whisper / sherpa-onnx). This wrapper imports the package ABSOLUTELY so both
the analysis and the runtime resolve the full module tree.
"""

import sys

from loqui_sidecar.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
