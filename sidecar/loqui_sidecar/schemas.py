"""Load + validate against the JSON Schemas emitted by ``@loqui/shared``.

The TypeScript contract package (``packages/shared``) is the single source of
truth. Its build step emits one ``<Name>.json`` Draft-07 schema per exported
type into ``packages/shared/schema/``. The sidecar loads those files at startup
and validates every inbound control / audio-control frame against them, so the
wire contract can never silently drift from the TS side.

Resolution order for the schema directory:

1. ``LOQUI_SCHEMA_DIR`` env var (used by tests / packaged builds).
2. Walk up from this file to the repo root (marked by ``pnpm-workspace.yaml``)
   and use ``packages/shared/schema``.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft7Validator
from jsonschema import exceptions as js_exceptions

#: Env var that overrides where the emitted JSON Schemas are read from.
SCHEMA_DIR_ENV = "LOQUI_SCHEMA_DIR"

#: Repo-root marker file used to locate ``packages/shared/schema`` in dev.
_ROOT_MARKER = "pnpm-workspace.yaml"

#: Schemas the sidecar validates inbound frames against (filename stem).
WS_ENVELOPE = "WsEnvelope"
AUDIO_START = "AudioStart"
AUDIO_STOP = "AudioStop"
#: PRD-4: the inbound `chatRequest` notification payload (main -> sidecar).
CHAT_REQUEST = "ChatRequest"


class SchemaError(RuntimeError):
    """The schema directory or a required schema file could not be loaded."""


class FrameValidationError(ValueError):
    """An inbound frame failed JSON Schema validation.

    ``message`` is sanitized: it carries the JSON path + a short reason but
    NEVER the offending instance, so a frame that happens to contain a secret
    (e.g. a stray ``token`` field) is not reflected back to the peer or logged.
    """

    def __init__(self, schema_name: str, message: str) -> None:
        self.schema_name = schema_name
        super().__init__(message)


def _resolve_schema_dir() -> Path:
    override = os.environ.get(SCHEMA_DIR_ENV)
    if override:
        path = Path(override).expanduser()
        if not path.is_dir():
            raise SchemaError(f"{SCHEMA_DIR_ENV}={override!r} is not a directory")
        return path

    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / _ROOT_MARKER).is_file():
            candidate = parent / "packages" / "shared" / "schema"
            if candidate.is_dir():
                return candidate
            raise SchemaError(
                f"found repo root {parent} but {candidate} is missing — "
                "build @loqui/shared first (pnpm --filter @loqui/shared build)"
            )
    raise SchemaError(
        "could not locate packages/shared/schema (no pnpm-workspace.yaml found "
        f"above {here}); set {SCHEMA_DIR_ENV} to point at the emitted schemas"
    )


def schema_dir() -> Path:
    """Absolute path to the directory of emitted JSON Schemas."""
    return _resolve_schema_dir()


@lru_cache(maxsize=None)
def _validator_for(schema_name: str) -> Draft7Validator:
    path = schema_dir() / f"{schema_name}.json"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:  # pragma: no cover - exercised via SchemaError path
        raise SchemaError(f"cannot read schema {schema_name} at {path}: {exc}") from exc
    schema = json.loads(raw)
    # Validate the schema itself so a malformed emit fails loudly at startup.
    Draft7Validator.check_schema(schema)
    return Draft7Validator(schema)


def validate(schema_name: str, payload: object) -> None:
    """Validate ``payload`` against the named emitted schema.

    Raises :class:`FrameValidationError` with a concise, JSON-path-prefixed
    message on failure. Raises :class:`SchemaError` if the schema is missing.
    """
    validator = _validator_for(schema_name)
    error = js_exceptions.best_match(validator.iter_errors(payload))
    if error is not None:
        location = "/".join(str(p) for p in error.absolute_path)
        prefix = f"{location}: " if location else ""
        raise FrameValidationError(schema_name, f"{prefix}{_safe_reason(error)}")


def _safe_reason(error: js_exceptions.ValidationError) -> str:
    """A diagnostic reason that NEVER includes the offending instance value.

    ``ValidationError.message`` interpolates the failing instance (e.g. the full
    frame for an ``anyOf``/``additionalProperties`` failure), which can leak a
    secret carried in the frame (such as a stray ``token``). We reconstruct a
    short, value-free reason from the failing keyword instead.
    """
    keyword = error.validator
    if keyword == "additionalProperties":
        # Name only the unexpected KEYS present on the instance, never values.
        allowed = set()
        schema = error.schema
        if isinstance(schema, dict) and isinstance(schema.get("properties"), dict):
            allowed = set(schema["properties"].keys())
        if isinstance(error.instance, dict):
            extras = sorted(k for k in error.instance if k not in allowed)
            if extras:
                return f"unexpected propertie(s): {', '.join(extras)}"
        return "additional properties are not allowed"
    if keyword == "required":
        return f"missing required property; expected one of {error.validator_value}"
    if keyword == "enum":
        return f"value not in allowed set {error.validator_value}"
    if keyword == "const":
        return f"value must equal {error.validator_value!r}"
    if keyword == "type":
        return f"wrong type; expected {error.validator_value}"
    if keyword == "anyOf":
        return "does not match any allowed frame shape"
    if keyword == "minLength":
        return f"string shorter than minimum length {error.validator_value}"
    # Fallback: name the keyword only, never the instance.
    return f"failed schema constraint {keyword!r}"


def is_valid(schema_name: str, payload: object) -> bool:
    """Return ``True`` iff ``payload`` validates against the named schema."""
    try:
        validate(schema_name, payload)
    except FrameValidationError:
        return False
    return True


def preload() -> None:
    """Eagerly load + compile the schemas the sidecar uses.

    Called during startup so a missing/broken schema dir fails before we print
    the handshake line and begin serving.
    """
    for name in (WS_ENVELOPE, AUDIO_START, AUDIO_STOP, CHAT_REQUEST):
        _validator_for(name)
