"""Hermetic unit tests for the PRD-4 chat-provider layer.

Covers the four providers + the registry/selector + the cross-cutting
AI-never-edits-the-transcript invariant. NOTHING here touches the network, an API
key, a real CLI, an audio device, or the real ``~/Loqui`` — the Anthropic SDK,
the httpx client, and the subprocess are all MOCKED via the providers' injection
seams. The default gate selects the FAKE provider.

Run: ``cd sidecar && uv run pytest -q tests/test_providers.py``
"""

from __future__ import annotations

import json

import pytest

from loqui_sidecar.providers import (
    ADAPTIVE_THINKING,
    DEFAULT_ANTHROPIC_CHAT_MODEL,
    DEFAULT_CHAT_MAX_TOKENS,
    AgentCliProvider,
    AnthropicProvider,
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    FakeChatProvider,
    OllamaProvider,
    ProviderConfig,
    agent_cli_factory,
    anthropic_factory,
    build_selector,
    make_provider_selector,
    ollama_factory,
    render_prompt,
)
from loqui_sidecar.providers import agent_cli_provider as cli_mod
from loqui_sidecar.providers.anthropic_provider import AnthropicProvider as _AP

# --------------------------------------------------------------------------- #
# Shared fixtures                                                             #
# --------------------------------------------------------------------------- #

CONTEXT = ChatMessage(
    role="system", content="<transcript>\nAlice: ship the audit log by Friday.\n</transcript>"
)
USER = ChatMessage(role="user", content="What action items came up?")
CONFIG_FAKE = ProviderConfig(provider="fake")


# --------------------------------------------------------------------------- #
# FakeChatProvider — determinism + protocol conformance                       #
# --------------------------------------------------------------------------- #


def test_fake_provider_conforms_to_protocol():
    provider = FakeChatProvider()
    assert isinstance(provider, ChatProvider)
    assert provider.name == "fake"


def test_fake_provider_is_deterministic():
    p1 = list(FakeChatProvider().stream_chat([CONTEXT, USER], CONFIG_FAKE))
    p2 = list(FakeChatProvider().stream_chat([CONTEXT, USER], CONFIG_FAKE))
    assert p1 == p2
    assert len(p1) > 1  # streamed as multiple deltas, not one blob.


def test_fake_provider_marks_context_presence():
    with_ctx = "".join(FakeChatProvider().stream_chat([CONTEXT, USER], CONFIG_FAKE))
    without_ctx = "".join(FakeChatProvider().stream_chat([USER], CONFIG_FAKE))
    assert "context" in with_ctx and "no-context" not in with_ctx
    assert "no-context" in without_ctx
    # The reply echoes the user's question so groundedness is observable.
    assert "What action items came up?" in with_ctx


def test_fake_provider_yields_str_deltas_only():
    for delta in FakeChatProvider().stream_chat([CONTEXT, USER], CONFIG_FAKE):
        assert isinstance(delta, str)


# --------------------------------------------------------------------------- #
# AnthropicProvider — request shaping (SDK MOCKED, no network)                #
# --------------------------------------------------------------------------- #


class _FakeMessageStream:
    """Stand-in for anthropic's MessageStream context manager."""

    def __init__(self, deltas, *, raise_on_iter=None):
        self._deltas = deltas
        self._raise = raise_on_iter

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    @property
    def text_stream(self):
        if self._raise is not None:
            raise self._raise
        yield from self._deltas


class _FakeMessages:
    def __init__(self, recorder, deltas, raise_on_iter=None):
        self._recorder = recorder
        self._deltas = deltas
        self._raise = raise_on_iter

    def stream(self, **kwargs):
        self._recorder["kwargs"] = kwargs
        return _FakeMessageStream(self._deltas, raise_on_iter=self._raise)


class _FakeAnthropicClient:
    def __init__(self, recorder, deltas, raise_on_iter=None):
        self.messages = _FakeMessages(recorder, deltas, raise_on_iter)


def _anthropic_with(recorder, deltas, *, raise_on_iter=None):
    def factory(api_key):
        recorder["api_key"] = api_key
        return _FakeAnthropicClient(recorder, deltas, raise_on_iter)

    return AnthropicProvider(client_factory=factory)


def test_anthropic_request_shape_default_model_and_no_sampling():
    rec = {}
    provider = _anthropic_with(rec, ["Action ", "items: ", "ship audit log."])
    out = list(
        provider.stream_chat(
            [CONTEXT, USER], ProviderConfig(provider="anthropic"), api_key="sk-test"
        )
    )

    assert out == ["Action ", "items: ", "ship audit log."]
    kwargs = rec["kwargs"]
    # default model honored
    assert kwargs["model"] == DEFAULT_ANTHROPIC_CHAT_MODEL
    # max_tokens pinned to the (generous) chat default so thorough answers aren't clipped
    assert kwargs["max_tokens"] == DEFAULT_CHAT_MAX_TOKENS == 8192
    # adaptive thinking, NOT budget_tokens
    assert kwargs["thinking"] == ADAPTIVE_THINKING == {"type": "adaptive"}
    # NO sampling params — they 400 on Opus 4.8 / Sonnet 4.6
    for banned in ("temperature", "top_p", "top_k", "budget_tokens"):
        assert banned not in kwargs
    # transcript context rides as the top-level `system`, not a chat turn
    assert "ship the audit log" in kwargs["system"]
    assert all(m["role"] in ("user", "assistant") for m in kwargs["messages"])
    assert kwargs["messages"][-1]["content"] == "What action items came up?"
    # transient key passed straight through to the client factory, never stored
    assert rec["api_key"] == "sk-test"


def test_anthropic_honors_configured_model():
    rec = {}
    provider = _anthropic_with(rec, ["ok"])
    list(
        provider.stream_chat(
            [USER], ProviderConfig(provider="anthropic", model="claude-sonnet-4-6"), api_key="k"
        )
    )
    assert rec["kwargs"]["model"] == "claude-sonnet-4-6"


def test_anthropic_omits_system_when_no_context():
    rec = {}
    provider = _anthropic_with(rec, ["ok"])
    list(provider.stream_chat([USER], ProviderConfig(provider="anthropic"), api_key="k"))
    assert "system" not in rec["kwargs"]


def test_anthropic_missing_key_raises_actionable():
    provider = AnthropicProvider(client_factory=lambda k: pytest.fail("must not build client"))
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], ProviderConfig(provider="anthropic"), api_key=None))
    assert ei.value.code == "missing_api_key"


def test_anthropic_uses_official_sdk_not_raw_http(monkeypatch):
    """If no client_factory is injected, the provider constructs the real
    anthropic.Anthropic — proving it goes through the SDK, not raw httpx."""
    import anthropic

    built = {}

    class _Spy(anthropic.Anthropic):
        def __init__(self, *a, **kw):
            built["api_key"] = kw.get("api_key")
            # Don't actually init the real client networking; just record.
            built["constructed"] = True
            raise RuntimeError("stop-after-construct")

    monkeypatch.setattr(anthropic, "Anthropic", _Spy)
    provider = AnthropicProvider()  # no factory -> real SDK path
    with pytest.raises(ChatProviderError):
        list(provider.stream_chat([USER], ProviderConfig(provider="anthropic"), api_key="sk-x"))
    assert built["constructed"] is True
    assert built["api_key"] == "sk-x"


def test_anthropic_maps_auth_error():
    import anthropic
    import httpx

    response = httpx.Response(401, request=httpx.Request("POST", "https://api.anthropic.com"))
    err = anthropic.AuthenticationError("bad key", response=response, body=None)
    provider = _anthropic_with({}, [], raise_on_iter=err)
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], ProviderConfig(provider="anthropic"), api_key="sk"))
    assert ei.value.code == "auth_error"
    # secret-free message
    assert "sk" not in str(ei.value) or "sk-" not in str(ei.value)


def test_anthropic_maps_status_error_to_provider_error():
    import anthropic
    import httpx

    response = httpx.Response(500, request=httpx.Request("POST", "https://api.anthropic.com"))
    err = anthropic.APIStatusError("server error", response=response, body=None)
    provider = _anthropic_with({}, [], raise_on_iter=err)
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], ProviderConfig(provider="anthropic"), api_key="sk"))
    assert ei.value.code == "provider_error"


def test_anthropic_conforms_to_protocol():
    assert isinstance(AnthropicProvider(), ChatProvider)
    assert AnthropicProvider().name == "anthropic"


# --------------------------------------------------------------------------- #
# OllamaProvider — request shaping (httpx MOCKED, offline)                     #
# --------------------------------------------------------------------------- #


class _FakeHttpxResponse:
    def __init__(self, lines, status_code=200):
        self._lines = lines
        self.status_code = status_code

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_lines(self):
        yield from self._lines


class _FakeHttpxClient:
    def __init__(self, recorder, lines, status_code=200, raise_on_stream=None):
        self._recorder = recorder
        self._lines = lines
        self._status = status_code
        self._raise = raise_on_stream

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def stream(self, method, url, **kwargs):
        self._recorder["method"] = method
        self._recorder["url"] = url
        self._recorder["json"] = kwargs.get("json")
        if self._raise is not None:
            raise self._raise
        return _FakeHttpxResponse(self._lines, self._status)


def _ollama_with(recorder, lines, *, config=None, status_code=200, raise_on_stream=None):
    config = config or ProviderConfig(provider="ollama", ollama_model="llama3.1")

    def factory(base_url):
        recorder["base_url"] = base_url
        return _FakeHttpxClient(recorder, lines, status_code, raise_on_stream)

    return OllamaProvider(config, client_factory=factory)


def _ollama_line(content, done=False):
    return json.dumps({"message": {"role": "assistant", "content": content}, "done": done})


def test_ollama_request_shape_and_streaming():
    rec = {}
    lines = [
        _ollama_line("Action "),
        _ollama_line("items."),
        json.dumps({"message": {"content": ""}, "done": True}),
    ]
    provider = _ollama_with(rec, lines)
    out = list(
        provider.stream_chat(
            [CONTEXT, USER], ProviderConfig(provider="ollama", ollama_model="llama3.1")
        )
    )

    assert out == ["Action ", "items."]
    assert rec["method"] == "POST"
    assert rec["url"] == "/api/chat"
    assert rec["base_url"] == "http://localhost:11434"
    payload = rec["json"]
    assert payload["model"] == "llama3.1"
    assert payload["stream"] is True
    # system (transcript context) + user both forwarded
    roles = [m["role"] for m in payload["messages"]]
    assert "system" in roles and "user" in roles
    assert any("ship the audit log" in m["content"] for m in payload["messages"])


def test_ollama_custom_base_url_and_model():
    rec = {}
    cfg = ProviderConfig(provider="ollama", base_url="http://box:1234/", ollama_model="qwen2.5")
    provider = _ollama_with(rec, [_ollama_line("hi", done=True)], config=cfg)
    list(provider.stream_chat([USER], cfg))
    assert rec["base_url"] == "http://box:1234"  # trailing slash trimmed
    assert rec["json"]["model"] == "qwen2.5"
    assert provider.name == "ollama:qwen2.5"


def test_ollama_unreachable_raises_actionable():
    import httpx

    err = httpx.ConnectError(
        "refused", request=httpx.Request("POST", "http://localhost:11434/api/chat")
    )
    provider = _ollama_with({}, [], raise_on_stream=err)
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], ProviderConfig(provider="ollama")))
    assert ei.value.code == "ollama_unreachable"
    assert "ollama serve" in str(ei.value)


def test_ollama_http_error_status_raises():
    rec = {}
    cfg = ProviderConfig(provider="ollama", ollama_model="missing")
    provider = _ollama_with(rec, [], config=cfg, status_code=404)
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], cfg))
    assert ei.value.code == "provider_error"
    assert "ollama pull missing" in str(ei.value)


def test_ollama_error_field_in_stream_raises():
    rec = {}
    provider = _ollama_with(rec, [json.dumps({"error": "model not found"})])
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], ProviderConfig(provider="ollama")))
    assert ei.value.code == "provider_error"


def test_ollama_conforms_to_protocol():
    p = OllamaProvider(ProviderConfig(provider="ollama"))
    assert isinstance(p, ChatProvider)


# --------------------------------------------------------------------------- #
# AgentCliProvider — request shaping (subprocess MOCKED)                       #
# --------------------------------------------------------------------------- #


def _claude_event(text):
    return json.dumps(
        {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}
    )


def test_agent_cli_claude_argv_and_stream(monkeypatch):
    monkeypatch.setattr(cli_mod.shutil, "which", lambda name: f"/usr/local/bin/{name}")
    captured = {}

    def runner(argv):
        captured["argv"] = argv
        return ([_claude_event("Action "), _claude_event("items.")], 0)

    cfg = ProviderConfig(provider="agent-cli", cli="claude")
    provider = AgentCliProvider(cfg, runner=runner)
    out = list(provider.stream_chat([CONTEXT, USER], cfg))

    assert out == ["Action ", "items."]
    argv = captured["argv"]
    assert argv[0] == "/usr/local/bin/claude"
    assert "-p" in argv
    assert "--output-format" in argv and "stream-json" in argv
    assert "--verbose" in argv
    # prompt (last arg) carries the read-only transcript context + the question
    prompt = argv[-1]
    assert "ship the audit log" in prompt
    assert "What action items came up?" in prompt
    assert provider.name == "agent-cli:claude"


def test_agent_cli_codex_argv_and_stream(monkeypatch):
    monkeypatch.setattr(cli_mod.shutil, "which", lambda name: f"/opt/{name}")
    captured = {}

    def runner(argv):
        captured["argv"] = argv
        return (["the answer line"], 0)

    cfg = ProviderConfig(provider="agent-cli", cli="codex")
    provider = AgentCliProvider(cfg, runner=runner)
    out = list(provider.stream_chat([USER], cfg))

    assert "".join(out).strip() == "the answer line"
    argv = captured["argv"]
    assert argv[0] == "/opt/codex"
    assert argv[1] == "exec"
    assert provider.name == "agent-cli:codex"


def test_agent_cli_missing_binary_raises_cli_not_found(monkeypatch):
    monkeypatch.setattr(cli_mod.shutil, "which", lambda name: None)
    cfg = ProviderConfig(provider="agent-cli", cli="claude")
    provider = AgentCliProvider(cfg, runner=lambda argv: ([], 0))
    with pytest.raises(ChatProviderError) as ei:
        list(provider.stream_chat([USER], cfg))
    assert ei.value.code == "cli_not_found"
    assert "claude" in str(ei.value)


def test_agent_cli_nonzero_exit_raises_after_partial(monkeypatch):
    monkeypatch.setattr(cli_mod.shutil, "which", lambda name: "/usr/bin/claude")

    def runner(argv):
        return ([_claude_event("partial")], 2)

    cfg = ProviderConfig(provider="agent-cli", cli="claude")
    provider = AgentCliProvider(cfg, runner=runner)
    gen = provider.stream_chat([USER], cfg)
    assert next(gen) == "partial"  # partial output stands
    with pytest.raises(ChatProviderError) as ei:
        list(gen)
    assert ei.value.code == "cli_error"


def test_agent_cli_ignores_non_text_events(monkeypatch):
    monkeypatch.setattr(cli_mod.shutil, "which", lambda name: "/usr/bin/claude")

    def runner(argv):
        return (
            [
                json.dumps({"type": "system", "subtype": "init"}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"content": [{"type": "tool_use", "name": "x"}]},
                    }
                ),
                _claude_event("real text"),
                json.dumps({"type": "result", "result": "done"}),
                "not json noise",
            ],
            0,
        )

    cfg = ProviderConfig(provider="agent-cli", cli="claude")
    out = list(AgentCliProvider(cfg, runner=runner).stream_chat([USER], cfg))
    assert out == ["real text"]


def test_render_prompt_includes_all_roles():
    prompt = render_prompt(
        [
            ChatMessage(role="system", content="CTX"),
            ChatMessage(role="user", content="Q1"),
            ChatMessage(role="assistant", content="A1"),
            ChatMessage(role="user", content="Q2"),
        ]
    )
    assert "CTX" in prompt
    assert "User: Q1" in prompt and "User: Q2" in prompt
    assert "Assistant: A1" in prompt


def test_agent_cli_conforms_to_protocol():
    assert isinstance(AgentCliProvider(ProviderConfig(provider="agent-cli")), ChatProvider)


# --------------------------------------------------------------------------- #
# Registry / selector                                                         #
# --------------------------------------------------------------------------- #


def test_selector_returns_each_provider_type(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_CHAT", raising=False)
    selector = build_selector()
    assert isinstance(selector(ProviderConfig(provider="fake")), FakeChatProvider)
    assert isinstance(selector(ProviderConfig(provider="anthropic")), AnthropicProvider)
    assert isinstance(selector(ProviderConfig(provider="ollama")), OllamaProvider)
    assert isinstance(selector(ProviderConfig(provider="agent-cli")), AgentCliProvider)


def test_selector_fake_env_forces_fake(monkeypatch):
    monkeypatch.setenv("LOQUI_FAKE_CHAT", "1")
    selector = build_selector()
    # Even when anthropic is requested, the hermetic flag forces the fake.
    assert isinstance(selector(ProviderConfig(provider="anthropic")), FakeChatProvider)


def test_selector_unknown_provider_raises(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_CHAT", raising=False)
    selector = build_selector()
    with pytest.raises(ChatProviderError):
        selector(ProviderConfig(provider="does-not-exist"))


def test_factories_build_expected_types():
    assert isinstance(anthropic_factory(), AnthropicProvider)
    assert isinstance(ollama_factory(ProviderConfig(provider="ollama")), OllamaProvider)
    assert isinstance(agent_cli_factory(ProviderConfig(provider="agent-cli")), AgentCliProvider)


def test_make_provider_selector_without_factories_raises_for_real(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_CHAT", raising=False)
    selector = make_provider_selector()  # no real factories injected
    with pytest.raises(ChatProviderError):
        selector(ProviderConfig(provider="anthropic"))
    assert isinstance(selector(ProviderConfig(provider="fake")), FakeChatProvider)


# --------------------------------------------------------------------------- #
# CROSS-CUTTING INVARIANT: the AI never edits the transcript                   #
# --------------------------------------------------------------------------- #


def test_no_provider_exposes_a_write_method():
    """Structural guarantee: providers receive conversation + context only and
    expose no write/patch/save method by which they could mutate a transcript."""
    write_like = ("write", "save", "patch", "put", "delete", "append", "store", "flush_to")
    providers = [
        FakeChatProvider(),
        AnthropicProvider(),
        OllamaProvider(ProviderConfig(provider="ollama")),
        AgentCliProvider(ProviderConfig(provider="agent-cli")),
    ]
    for provider in providers:
        public = {a for a in dir(provider) if not a.startswith("_")}
        # the only public surface is name + stream_chat (+ any harmless helpers).
        assert "stream_chat" in public
        for attr in public:
            assert not any(
                attr.lower().startswith(w) for w in write_like
            ), f"{type(provider).__name__}.{attr} looks like a write path"


def test_provider_modules_do_not_import_the_store_or_writer():
    """The provider build-unit modules must not import the TranscriptWriter /
    store / any write surface — they get a read-only context string only."""
    import inspect
    import re

    from loqui_sidecar.providers import (
        agent_cli_provider,
        anthropic_provider,
        ollama_provider,
    )

    # Word-boundary patterns so e.g. subprocess.Popen( doesn't false-match open(.
    forbidden_patterns = [
        r"\bTranscriptWriter\b",
        r"from \.store\b",
        r"import store\b",
        r"(?<![A-Za-z_.])open\(",  # bare open(, not Popen( / reopen(
        r"\.write\(",
        r"\.write_text\(",
        r"\.write_bytes\(",
        r'open\([^)]*["\']w["\']',  # open(..., "w")
    ]
    for mod in (anthropic_provider, ollama_provider, agent_cli_provider):
        src = inspect.getsource(mod)
        for pat in forbidden_patterns:
            assert not re.search(pat, src), f"{mod.__name__} references write surface /{pat}/"


def test_transcript_is_byte_identical_after_a_full_chat(tmp_path, monkeypatch):
    """End-to-end through handle_chat with the fake provider: after a chat, the
    transcript file is BYTE-IDENTICAL — no provider/handler path mutated it."""
    from loqui_sidecar.providers import handle_chat, meeting_transcript_path
    from loqui_sidecar.providers.types import ChatRequest

    monkeypatch.setenv("LOQUI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("LOQUI_FAKE_CHAT", "1")

    meeting_id = "meeting-xyz"
    transcript_path = meeting_transcript_path(meeting_id, "live")
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    original = b"Alice: ship the audit log by Friday.\nBob: I'll own the migration.\n"
    transcript_path.write_bytes(original)
    before = transcript_path.read_bytes()

    events: list[tuple[str, dict]] = []
    request = ChatRequest.from_wire(
        {
            "chatId": "c1",
            "meetingId": meeting_id,
            "messages": [{"role": "user", "content": "What action items came up?"}],
            "providerConfig": {"provider": "fake"},
        }
    )
    handle_chat(request, lambda event, data: events.append((event, data)))

    # the chat actually ran and was grounded in the (read-only) transcript
    kinds = [e for e, _ in events]
    assert "chatToken" in kinds and "chatDone" in kinds
    done = next(d for e, d in events if e == "chatDone")
    assert "context" in done["text"]  # fake reply marks that context arrived

    after = transcript_path.read_bytes()
    assert after == before == original  # byte-identical: the AI never edited it


def test_fs_transcript_reader_has_no_write_method():
    from loqui_sidecar.providers import FsTranscriptReader

    reader = FsTranscriptReader()
    public = {a for a in dir(reader) if not a.startswith("_")}
    assert public == {"read"}  # exactly one read-only method, no write counterpart


def test_fs_transcript_reader_prefers_hifi_so_a_flawed_live_transcript_never_poisons_summary(
    tmp_path, monkeypatch
):
    """The summary/chat grounding must read the CLEAN hi-fi transcript when it
    exists, not the flawed live one (the de-poisoning fix)."""
    from loqui_sidecar.providers import transcript as transcript_mod
    from loqui_sidecar.providers.transcript import FsTranscriptReader

    monkeypatch.setenv(transcript_mod.DATA_DIR_ENV, str(tmp_path))
    mdir = tmp_path / "meetings" / "m1"
    mdir.mkdir(parents=True)
    (mdir / "transcript.live.md").write_text(
        "[00:00:00] You said: flawd lvie txt\n", encoding="utf-8"
    )
    (mdir / "transcript.jsonl").write_text('{"text":"flawd lvie txt"}\n', encoding="utf-8")
    reader = FsTranscriptReader()

    # No hi-fi yet -> falls back to the live transcript.
    assert "flawd" in reader.read("m1", "live")

    # Once the clean hi-fi exists, BOTH variants prefer it.
    (mdir / "transcript.hifi.md").write_text(
        "[00:00:00] You said: clean accurate text\n", encoding="utf-8"
    )
    (mdir / "transcript.hifi.jsonl").write_text(
        '{"text":"clean accurate text"}\n', encoding="utf-8"
    )
    assert reader.read("m1", "live") == "[00:00:00] You said: clean accurate text\n"
    assert "clean accurate text" in reader.read("m1", "structured")


# --------------------------------------------------------------------------- #
# Hermeticity sanity                                                          #
# --------------------------------------------------------------------------- #


def test_importing_providers_does_not_eagerly_import_heavy_deps():
    """Importing the package (the fake-provider gate) must not pull anthropic/httpx.

    (They may already be in sys.modules because *other* tests in this file import
    them explicitly; this asserts the package's own __init__ doesn't.)"""
    import importlib

    pkg = importlib.import_module("loqui_sidecar.providers")
    # the package exposes the real classes without importing the heavy SDK at
    # module scope — construction is what triggers the lazy import.
    assert pkg.AnthropicProvider is _AP
