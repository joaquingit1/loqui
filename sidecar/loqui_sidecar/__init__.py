"""Loqui Python sidecar package."""

# Kept in sync with packages/shared `PROTOCOL_VERSION`; the handshake fails
# loudly on mismatch. The Build phase wires the validation.
PROTOCOL_VERSION = "0.1.0"

__all__ = ["PROTOCOL_VERSION"]
