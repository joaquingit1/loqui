"""Unit tests for the shared-schema loader/validator (no server needed)."""

from __future__ import annotations

import uuid

import pytest

from loqui_sidecar import schemas


def test_schema_dir_resolves_to_emitted_schemas():
    d = schemas.schema_dir()
    assert d.is_dir()
    assert (d / "WsEnvelope.json").is_file()
    assert (d / "AudioStart.json").is_file()
    assert (d / "AudioStop.json").is_file()


def test_preload_compiles_required_schemas():
    # Should not raise: all three required schemas load + self-check.
    schemas.preload()


def test_schema_dir_env_override(tmp_path, monkeypatch):
    (tmp_path / "WsEnvelope.json").write_text('{"type":"object"}', encoding="utf-8")
    monkeypatch.setenv(schemas.SCHEMA_DIR_ENV, str(tmp_path))
    schemas._validator_for.cache_clear()
    try:
        assert schemas.schema_dir() == tmp_path
        # The minimal stub schema accepts an object.
        schemas.validate("WsEnvelope", {"anything": 1})
    finally:
        schemas._validator_for.cache_clear()


def test_schema_dir_env_override_missing_raises(tmp_path, monkeypatch):
    monkeypatch.setenv(schemas.SCHEMA_DIR_ENV, str(tmp_path / "nope"))
    with pytest.raises(schemas.SchemaError):
        schemas.schema_dir()


# --- WsEnvelope: accepts valid -------------------------------------------------


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "request", "id": "1", "method": "ping"},
        {"type": "request", "id": "abc", "method": "getHealth", "params": {"x": 1}},
        {"type": "request", "id": "z", "method": "shutdown"},
        {"type": "response", "id": "1", "ok": True, "result": {"pong": True}},
        {"type": "error", "id": None, "ok": False, "error": {"code": "x", "message": "y"}},
        {"type": "notification", "event": "audioStart", "data": {}},
    ],
)
def test_ws_envelope_accepts_valid(frame):
    schemas.validate(schemas.WS_ENVELOPE, frame)
    assert schemas.is_valid(schemas.WS_ENVELOPE, frame)


# --- WsEnvelope: rejects invalid ----------------------------------------------


@pytest.mark.parametrize(
    "frame",
    [
        {"type": "request", "id": "1", "method": "bogus"},  # bad method enum
        {"type": "request", "method": "ping"},  # missing id
        {"type": "request", "id": "1"},  # missing method
        {"type": "request", "id": "", "method": "ping"},  # empty id (minLength 1)
        {"type": "totally-unknown", "id": "1"},  # bad discriminator
        {"type": "request", "id": "1", "method": "ping", "extra": 1},  # additionalProperties
        "not even an object",
        42,
    ],
)
def test_ws_envelope_rejects_invalid(frame):
    assert not schemas.is_valid(schemas.WS_ENVELOPE, frame)
    with pytest.raises(schemas.FrameValidationError):
        schemas.validate(schemas.WS_ENVELOPE, frame)


# --- Audio control frames ------------------------------------------------------


def test_audio_start_accepts_valid():
    schemas.validate(
        schemas.AUDIO_START,
        {"meetingId": str(uuid.uuid4()), "source": "mic"},
    )
    schemas.validate(
        schemas.AUDIO_START,
        {
            "meetingId": str(uuid.uuid4()),
            "source": "system",
            "sampleRate": 16000,
            "channels": 1,
            "encoding": "pcm_s16le",
        },
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"source": "mic"},  # missing meetingId
        {"meetingId": str(uuid.uuid4())},  # missing source
        {"meetingId": str(uuid.uuid4()), "source": "speaker"},  # bad source enum
        {"meetingId": str(uuid.uuid4()), "source": "mic", "extra": 1},  # additionalProperties
    ],
)
def test_audio_start_rejects_invalid(payload):
    assert not schemas.is_valid(schemas.AUDIO_START, payload)


def test_audio_stop_round_trip():
    schemas.validate(schemas.AUDIO_STOP, {"meetingId": str(uuid.uuid4()), "source": "system"})
    assert not schemas.is_valid(schemas.AUDIO_STOP, {"source": "system"})


def test_validation_error_message_includes_path():
    with pytest.raises(schemas.FrameValidationError) as ei:
        schemas.validate(schemas.AUDIO_START, {"meetingId": str(uuid.uuid4()), "source": "nope"})
    assert "source" in str(ei.value)
