"""Hermetic unit tests for the sidecar chat orchestration (PRD-4).

Scope: the READ-ONLY transcript accessor + ``handle_chat`` orchestration in
``loqui_sidecar.providers``. Everything here is hermetic by construction:

* no network, no API key, no CLI, no audio device, no real ``~/Loqui`` — every
  test points ``LOQUI_DATA_DIR`` at a pytest ``tmp_path`` and drives the
  deterministic :class:`FakeChatProvider` (or a tiny scripted stub) directly;
* ``emit`` is captured into an in-memory list, so we assert the exact
  ``chatToken`` / ``chatDone`` / ``chatError`` notification sequence.

The headline assertion is the CROSS-CUTTING INVARIANT: **the AI never edits the
transcript.** We prove it two ways — structurally (the chat modules expose no
write/patch function and the reader has only ``read``) and behaviorally (the
transcript file is byte-identical before and after a chat, including an error
path where the provider raises mid-stream).
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator, Optional

import pytest

from loqui_sidecar.providers import (
    CONTEXT_CHAR_BUDGET,
    FAKE_CHAT_ENV,
    CHAT_DONE_EVENT,
    CHAT_ERROR_EVENT,
    CHAT_TOKEN_EVENT,
    ChatMessage,
    ChatProviderError,
    ChatRequest,
    FsTranscriptReader,
    ProviderConfig,
    build_context_message,
    default_transcript_reader,
    fake_chat_enabled,
    handle_chat,
    make_provider_selector,
    meeting_transcript_path,
)
from loqui_sidecar.providers import fake as fake_mod
from loqui_sidecar.providers import handler as handler_mod
from loqui_sidecar.providers import transcript as transcript_mod
from loqui_sidecar.providers.fake import FakeChatProvider

# --- helpers ------------------------------------------------------------------

#: Transcript content used across tests. The grounding marker "Falcon-7" is a
#: distinctive string we can later assert reached the provider as context.
SAMPLE_TRANSCRIPT = (
    "## Live transcript\n\n"
    "Alice: We agreed to ship the Falcon-7 release on Friday.\n"
    "Bob: I'll own the migration. Action item: Bob writes the runbook.\n"
    "Alice: Great, let's sync again Thursday.\n"
)


def _seed_transcript(data_dir: Path, meeting_id: str, text: str = SAMPLE_TRANSCRIPT) -> Path:
    """Write a ``transcript.live.md`` under a temp data root and return its path."""
    path = data_dir / "meetings" / meeting_id / "transcript.live.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    """A hermetic temp data root. Points ``LOQUI_DATA_DIR`` at it so the on-disk
    :class:`FsTranscriptReader` never touches the real ``~/Loqui``. Also clears
    the fake-chat env flag so a test opts into it explicitly.
    """
    root = tmp_path / "Loqui"
    root.mkdir()
    monkeypatch.setenv(transcript_mod.DATA_DIR_ENV, str(root))
    monkeypatch.delenv(FAKE_CHAT_ENV, raising=False)
    return root


def _collect_emit():
    """An ``emit`` callable that records ``(event, data)`` tuples in order."""
    events: list[tuple[str, dict]] = []

    def emit(event: str, data: dict) -> None:
        events.append((event, data))

    return events, emit


def _request(meeting_id: str, user_text: str, *, provider: str = "fake") -> ChatRequest:
    return ChatRequest(
        chat_id="chat-1",
        meeting_id=meeting_id,
        messages=[ChatMessage(role="user", content=user_text)],
        config=ProviderConfig(provider=provider),
        api_key=None,
    )


# --- read-only transcript accessor --------------------------------------------


def test_reader_reads_seeded_transcript(data_dir):
    _seed_transcript(data_dir, "m1")
    reader = default_transcript_reader()
    assert reader.read("m1") == SAMPLE_TRANSCRIPT


def test_reader_returns_empty_when_absent(data_dir):
    # No file seeded -> "" (not an exception). A brand-new meeting has no text.
    assert default_transcript_reader().read("does-not-exist") == ""


def test_reader_honors_data_dir_env(data_dir):
    _seed_transcript(data_dir, "m1")
    expected = data_dir / "meetings" / "m1" / "transcript.live.md"
    assert meeting_transcript_path("m1") == expected


def test_meeting_path_rejects_unsafe_id(data_dir):
    # An adversarial id from the renderer cannot escape the meetings dir.
    for bad in ("../evil", "..", ".", "a/b", "", "x" * 200):
        with pytest.raises(ValueError):
            meeting_transcript_path(bad)


# --- streaming happy path -----------------------------------------------------


def test_handle_chat_streams_tokens_then_done(data_dir):
    _seed_transcript(data_dir, "m1")
    events, emit = _collect_emit()

    handle_chat(_request("m1", "What action items came up?"), emit)

    kinds = [e for e, _ in events]
    # At least one token, exactly one terminal done, no error.
    assert kinds.count(CHAT_DONE_EVENT) == 1
    assert CHAT_ERROR_EVENT not in kinds
    assert kinds.index(CHAT_DONE_EVENT) == len(kinds) - 1  # done is last
    assert kinds[:-1] == [CHAT_TOKEN_EVENT] * (len(kinds) - 1)
    assert len(kinds) >= 2  # tokens + done

    # Every token carries the chatId + a non-empty delta.
    for event, data in events:
        if event == CHAT_TOKEN_EVENT:
            assert data["chatId"] == "chat-1"
            assert data["delta"]

    # chatDone.text is the concatenation of the streamed deltas.
    deltas = [d["delta"] for e, d in events if e == CHAT_TOKEN_EVENT]
    done = next(d for e, d in events if e == CHAT_DONE_EVENT)
    assert done["text"] == "".join(deltas)
    assert done["chatId"] == "chat-1"
    assert done["provider"] == "fake"
    assert done["model"] == "fake"


def test_streamed_reply_reflects_transcript_grounding(data_dir):
    """The fake provider emits a "context" marker iff a non-empty system/context
    message reached it — proving the read-only transcript was injected as context.
    """
    _seed_transcript(data_dir, "m1")
    events, emit = _collect_emit()
    handle_chat(_request("m1", "summarize"), emit)
    text = "".join(d["delta"] for e, d in events if e == CHAT_TOKEN_EVENT)
    assert "context" in text  # grounded
    assert "no-context" not in text


def test_no_transcript_means_no_context_message(data_dir):
    """A meeting with no transcript yet still streams (the fake reports
    "no-context"); the handler simply prepends no system message."""
    events, emit = _collect_emit()
    handle_chat(_request("brand-new", "hi"), emit)
    text = "".join(d["delta"] for e, d in events if e == CHAT_TOKEN_EVENT)
    assert "no-context" in text
    assert any(e == CHAT_DONE_EVENT for e, _ in events)


def test_fake_provider_forced_by_env_over_config(data_dir, monkeypatch):
    """``LOQUI_FAKE_CHAT`` forces the fake even when the config asks for a real
    provider — keeps the gate hermetic regardless of providerConfig."""
    monkeypatch.setenv(FAKE_CHAT_ENV, "1")
    assert fake_chat_enabled() is True
    _seed_transcript(data_dir, "m1")
    events, emit = _collect_emit()
    # Config requests "anthropic" but env forces fake -> no network/key needed.
    handle_chat(_request("m1", "hi", provider="anthropic"), emit)
    assert any(e == CHAT_DONE_EVENT for e, _ in events)
    assert not any(e == CHAT_ERROR_EVENT for e, _ in events)


# --- error path ---------------------------------------------------------------


class _RaisingProvider:
    """A provider that yields a couple of deltas then raises — to assert the
    handler emits the already-streamed tokens, then a single ``chatError``."""

    name = "raiser"

    def __init__(self, code: str = "provider_error", *, partial: bool = True) -> None:
        self._code = code
        self._partial = partial

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        if self._partial:
            yield "partial-"
            yield "answer "
        raise ChatProviderError(self._code, "the provider blew up (no secrets here)")


def test_handle_chat_emits_chat_error_on_provider_failure(data_dir):
    _seed_transcript(data_dir, "m1")
    events, emit = _collect_emit()

    handle_chat(
        _request("m1", "go"),
        emit,
        selector=lambda cfg: _RaisingProvider("provider_error"),
    )

    kinds = [e for e, _ in events]
    # Partial tokens streamed first, then exactly one terminal error, no done.
    assert kinds.count(CHAT_TOKEN_EVENT) == 2
    assert kinds.count(CHAT_ERROR_EVENT) == 1
    assert CHAT_DONE_EVENT not in kinds
    assert kinds[-1] == CHAT_ERROR_EVENT

    err = next(d for e, d in events if e == CHAT_ERROR_EVENT)
    assert err["chatId"] == "chat-1"
    assert err["code"] == "provider_error"
    assert err["message"]  # actionable, non-empty


def test_unexpected_exception_maps_to_internal_error(data_dir):
    """A non-:class:`ChatProviderError` crash must not escape into app.py's
    worker — it becomes a single ``chatError`` with code ``internal_error``."""
    _seed_transcript(data_dir, "m1")
    events, emit = _collect_emit()

    def boom(cfg):
        class _Boom:
            name = "boom"

            def stream_chat(self, *a, **k):
                raise RuntimeError("unexpected")

        return _Boom()

    handle_chat(_request("m1", "go"), emit, selector=boom)
    errs = [d for e, d in events if e == CHAT_ERROR_EVENT]
    assert len(errs) == 1
    assert errs[0]["code"] == "internal_error"
    assert not any(e == CHAT_DONE_EVENT for e, _ in events)


def test_handle_chat_never_leaks_api_key_in_events(data_dir):
    """The transient BYOK key is never echoed into any emitted notification."""
    _seed_transcript(data_dir, "m1")
    events, emit = _collect_emit()
    secret = "sk-ant-SUPER-SECRET-KEY"
    req = ChatRequest(
        chat_id="chat-1",
        meeting_id="m1",
        messages=[ChatMessage(role="user", content="hi")],
        config=ProviderConfig(provider="fake"),
        api_key=secret,
    )
    handle_chat(req, emit)
    blob = repr(events)
    assert secret not in blob


# --- read-only invariant (the headline) ---------------------------------------


def test_chat_modules_expose_no_write_function():
    """Structural enforcement: none of the chat/provider modules expose a
    write/patch/persist surface, and the reader has only ``read``."""
    # The reader protocol-implementing class exposes exactly one public method.
    public = [m for m in dir(FsTranscriptReader) if not m.startswith("_")]
    assert public == ["read"]

    forbidden = ("write", "patch", "save", "persist", "delete", "mutate", "update")
    for mod in (handler_mod, transcript_mod, fake_mod):
        for name in dir(mod):
            if name.startswith("_"):
                continue
            lowered = name.lower()
            assert not any(
                k in lowered for k in forbidden
            ), f"{mod.__name__}.{name} looks like a write surface"
    # The reader instance has no write counterpart at runtime either.
    reader = default_transcript_reader()
    for attr in ("write", "write_text", "patch", "save"):
        assert not hasattr(reader, attr)


def test_transcript_is_byte_identical_after_chat(data_dir):
    """Behavioral proof of the invariant: a full chat leaves the transcript file
    byte-for-byte unchanged."""
    path = _seed_transcript(data_dir, "m1")
    before = path.read_bytes()

    events, emit = _collect_emit()
    handle_chat(_request("m1", "What action items came up?"), emit)

    assert any(e == CHAT_DONE_EVENT for e, _ in events)  # the chat actually ran
    assert path.read_bytes() == before


def test_transcript_is_byte_identical_after_error_path(data_dir):
    """Even when the provider raises mid-stream, the transcript is untouched."""
    path = _seed_transcript(data_dir, "m1")
    before = path.read_bytes()

    events, emit = _collect_emit()
    handle_chat(
        _request("m1", "go"),
        emit,
        selector=lambda cfg: _RaisingProvider("provider_error"),
    )

    assert any(e == CHAT_ERROR_EVENT for e, _ in events)
    assert path.read_bytes() == before


# --- long-transcript context fallback -----------------------------------------


def test_build_context_message_passes_full_transcript_below_budget(data_dir):
    _seed_transcript(data_dir, "m1")
    msg = build_context_message(default_transcript_reader(), "m1")
    assert msg is not None
    assert msg.role == "system"
    # The whole transcript appears verbatim inside the context envelope.
    assert SAMPLE_TRANSCRIPT in msg.content
    assert "<transcript>" in msg.content


def test_build_context_message_none_when_empty(data_dir):
    # Whitespace-only / absent transcript -> no system message.
    _seed_transcript(data_dir, "m1", text="   \n\t\n")
    assert build_context_message(default_transcript_reader(), "m1") is None
    assert build_context_message(default_transcript_reader(), "absent") is None


def test_long_transcript_falls_back_to_recent_tail(data_dir):
    """Above :data:`CONTEXT_CHAR_BUDGET` the handler trims to the recent tail
    (the documented Foundation fallback). Assert: the tail survives, the head is
    dropped, and the kept slice never exceeds the budget."""
    head = "HEAD_MARKER_OLD " + ("filler old line.\n" * 4000)
    tail = "\nTAIL_MARKER_RECENT: the final decision was to ship."
    big = head + tail
    assert len(big) > CONTEXT_CHAR_BUDGET  # precondition: genuinely over budget
    _seed_transcript(data_dir, "m1", text=big)

    msg = build_context_message(default_transcript_reader(), "m1")
    assert msg is not None
    assert "TAIL_MARKER_RECENT" in msg.content  # recent tail kept
    assert "HEAD_MARKER_OLD" not in msg.content  # old head dropped
    # The injected transcript slice is bounded by the documented budget.
    inner = msg.content.split("<transcript>\n", 1)[1].rsplit("\n</transcript>", 1)[0]
    assert len(inner) <= CONTEXT_CHAR_BUDGET


def test_long_transcript_still_streams_end_to_end(data_dir):
    """End-to-end over a >budget transcript: still streams tokens + done, with
    grounding context present (fake reports "context")."""
    big = ("x" * (CONTEXT_CHAR_BUDGET + 5000)) + "\nFINAL: ship it."
    _seed_transcript(data_dir, "m1", text=big)
    events, emit = _collect_emit()
    handle_chat(_request("m1", "summary?"), emit)
    text = "".join(d["delta"] for e, d in events if e == CHAT_TOKEN_EVENT)
    assert "context" in text
    assert any(e == CHAT_DONE_EVENT for e, _ in events)


# --- provider selector seam ---------------------------------------------------


def test_default_selector_raises_for_unwired_provider(data_dir):
    """Foundation's default selector ships only the fake; asking for a real,
    not-yet-wired provider surfaces an actionable ``chatError`` (no crash)."""
    events, emit = _collect_emit()
    handle_chat(_request("m1", "hi", provider="ollama"), emit)
    errs = [d for e, d in events if e == CHAT_ERROR_EVENT]
    assert len(errs) == 1
    assert errs[0]["code"] in ("internal_error", "provider_error")
    assert not any(e == CHAT_DONE_EVENT for e, _ in events)


def test_make_provider_selector_injects_real_factories(data_dir):
    """The build-unit injection seam: a custom selector routes a config to the
    injected factory and the handler streams its output."""
    _seed_transcript(data_dir, "m1")

    class _Stub:
        name = "ollama-stub"

        def stream_chat(self, messages, config, api_key=None):
            yield "from "
            yield "ollama"

    selector = make_provider_selector(ollama_factory=lambda cfg: _Stub())
    events, emit = _collect_emit()
    req = _request("m1", "hi", provider="ollama")
    handle_chat(req, emit, selector=selector)

    text = "".join(d["delta"] for e, d in events if e == CHAT_TOKEN_EVENT)
    assert text == "from ollama"
    done = next(d for e, d in events if e == CHAT_DONE_EVENT)
    assert done["model"] == "ollama-stub"


def test_make_provider_selector_env_forces_fake(data_dir, monkeypatch):
    """Even with real factories injected, ``LOQUI_FAKE_CHAT`` wins and returns
    the fake — so the gate/smoke stay hermetic."""
    monkeypatch.setenv(FAKE_CHAT_ENV, "1")
    selector = make_provider_selector(
        anthropic_factory=lambda: (_ for _ in ()).throw(AssertionError("must not be called")),
    )
    provider = selector(ProviderConfig(provider="anthropic"))
    assert isinstance(provider, FakeChatProvider)


# --- ChatRequest wire decoding (camelCase contract) ---------------------------


def test_chat_request_from_wire_decodes_camelcase(data_dir):
    _seed_transcript(data_dir, "m1")
    req = ChatRequest.from_wire(
        {
            "chatId": "c9",
            "meetingId": "m1",
            "messages": [{"role": "user", "content": "hello"}],
            "providerConfig": {"provider": "fake", "model": "claude-opus-4-8"},
            "apiKey": None,
        }
    )
    assert req.chat_id == "c9"
    assert req.meeting_id == "m1"
    assert req.config.provider == "fake"
    assert req.messages[0] == ChatMessage(role="user", content="hello")

    events, emit = _collect_emit()
    handle_chat(req, emit)
    done = next(d for e, d in events if e == CHAT_DONE_EVENT)
    assert done["chatId"] == "c9"
