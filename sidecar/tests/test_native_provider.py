"""PRD-10 — native on-device summary/chat providers behind the injectable helper.

Hermetic: a FAKE helper scripts the documented summary line/JSON protocol (NO
Swift binary, NO Apple model, NO MLX, NO network), so the protocol parsing, the
text mapping, the error mapping, and the read-only invariant are all verified on
Windows. The real Swift compile + the real Apple Foundation Models / MLX run are
Mac/CI-only (see ``test_native_summary_real.py``, skipped here).
"""

from __future__ import annotations

import threading
import time

import pytest

from ._summary_helpers import FakeSummaryHelper, SpawningFactory
from ._summary_helpers import helper_factory as _factory

from loqui_sidecar.providers import native_provider as native_mod
from loqui_sidecar.providers.native_provider import (
    BundledMlxProvider,
    NativeChatProvider,
    mlx_factory,
    native_factory,
    probe_summary_capabilities,
    shutdown_warm_helpers,
)
from loqui_sidecar.providers.types import (
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    ProviderConfig,
)


@pytest.fixture(autouse=True)
def _reset_warm_pool():
    """The warm helper pool is module-global (it must outlive the per-request
    provider instances the selector rebuilds), so reset it around every test for
    isolation — otherwise one test's warm helper is reused by the next."""
    shutdown_warm_helpers()
    yield
    shutdown_warm_helpers()


def _messages(user: str = "Summarize the meeting.") -> list[ChatMessage]:
    return [
        ChatMessage(role="system", content="<transcript>\nAlice: hello\n</transcript>"),
        ChatMessage(role="user", content=user),
    ]


# --- protocol conformance -----------------------------------------------------


def test_native_provider_conforms_to_chat_protocol():
    provider = NativeChatProvider(helper_factory=_factory(FakeSummaryHelper()))
    assert isinstance(provider, ChatProvider)
    assert provider.name == "native"


def test_mlx_provider_name_includes_model():
    provider = BundledMlxProvider(
        ProviderConfig(provider="mlx", native_model="qwen2.5-3b"),
        helper_factory=_factory(FakeSummaryHelper()),
    )
    assert isinstance(provider, ChatProvider)
    assert provider.name == "mlx:qwen2.5-3b"


# --- generation maps the protocol correctly -----------------------------------


def test_native_provider_generates_summary_via_helper():
    helper = FakeSummaryHelper(text="the meeting agreed to ship")
    provider = NativeChatProvider(helper_factory=_factory(helper))

    out = "".join(provider.stream_chat(_messages(), ProviderConfig(provider="native")))

    assert out == "the meeting agreed to ship"
    # The helper is kept WARM: one start (with the apple-foundation engine) + one
    # generate — no per-turn stop (the process is reused across turns; stop/close
    # only happen on idle-timeout / provider close / shutdown).
    types = [m["type"] for m in helper.sent]
    assert types == ["summaryStart", "summaryGenerate"]
    assert helper.sent[0]["engine"] == "apple-foundation"
    # The transcript context rides on the SYSTEM channel (-> session instructions),
    # the ask rides as the USER prompt — both reach the helper.
    assert "<transcript>" in helper.sent[1]["system"]
    assert "Summarize the meeting." in helper.sent[1]["prompt"]
    assert helper.closed is False  # warm: not torn down after one turn

    # Explicit close tears the warm helper down + sends the terminal stop.
    provider.close()
    assert helper.closed is True
    assert helper.sent[-1]["type"] == "summaryStop"


def test_mlx_provider_uses_mlx_engine_and_model():
    helper = FakeSummaryHelper(text="mlx summary")
    cfg = ProviderConfig(provider="mlx", native_model="gemma-2-2b")
    provider = BundledMlxProvider(cfg, helper_factory=_factory(helper))

    out = "".join(provider.stream_chat(_messages(), cfg))

    assert out == "mlx summary"
    assert helper.sent[0]["engine"] == "mlx"
    assert helper.sent[0]["model"] == "gemma-2-2b"


# --- error mapping ------------------------------------------------------------


def test_native_provider_start_error_maps_to_chat_error():
    helper = FakeSummaryHelper(fail_start=True)
    provider = NativeChatProvider(helper_factory=_factory(helper))
    with pytest.raises(ChatProviderError) as exc:
        list(provider.stream_chat(_messages(), ProviderConfig(provider="native")))
    assert exc.value.code in ("provider_error", "internal_error")
    assert "unavailable" in str(exc.value)
    assert helper.closed is True


def test_native_provider_generate_error_maps_to_chat_error():
    helper = FakeSummaryHelper(fail_generate=True)
    provider = NativeChatProvider(helper_factory=_factory(helper))
    with pytest.raises(ChatProviderError):
        list(provider.stream_chat(_messages(), ProviderConfig(provider="native")))


# --- cross-platform fallback (no helper) --------------------------------------


def test_native_provider_without_helper_raises_actionable_error():
    """On Windows / unbundled the factory is None -> a stable, actionable error
    (the selector's fallback signal), never a crash."""
    provider = NativeChatProvider(helper_factory=None)
    with pytest.raises(ChatProviderError) as exc:
        list(provider.stream_chat(_messages(), ProviderConfig(provider="native")))
    assert "unavailable" in str(exc.value).lower()


def test_mlx_provider_without_helper_raises_actionable_error():
    provider = BundledMlxProvider(helper_factory=None)
    with pytest.raises(ChatProviderError):
        list(provider.stream_chat(_messages(), ProviderConfig(provider="mlx")))


# --- summary capability probe -------------------------------------------------


def test_probe_summary_capabilities_returns_helper_engines():
    helper = FakeSummaryHelper(engines=["apple-foundation", "mlx"])
    assert probe_summary_capabilities(_factory(helper)) == ["apple-foundation", "mlx"]


def test_probe_summary_capabilities_none_factory_is_empty(monkeypatch):
    # When the default subprocess factory is None (no helper binary), the probe is
    # empty — exactly the Windows fallback signal.
    monkeypatch.setattr(
        "loqui_sidecar.providers.native_provider._default_subprocess_factory",
        lambda: None,
    )
    assert probe_summary_capabilities() == []


# --- read-only invariant: no write path ---------------------------------------


def test_native_providers_expose_no_write_method():
    for provider in (
        NativeChatProvider(helper_factory=_factory(FakeSummaryHelper())),
        BundledMlxProvider(helper_factory=_factory(FakeSummaryHelper())),
    ):
        names = [n for n in dir(provider) if not n.startswith("_")]
        for forbidden in ("write", "save", "patch", "put", "delete", "append", "store"):
            assert not any(
                forbidden in n.lower() for n in names
            ), f"{type(provider).__name__} exposes a write-like method: {names}"


# --- factories ----------------------------------------------------------------


def test_factories_build_the_right_providers():
    assert isinstance(native_factory(ProviderConfig(provider="native")), NativeChatProvider)
    assert isinstance(mlx_factory(ProviderConfig(provider="mlx")), BundledMlxProvider)


# --- provider selection + cross-platform fallback + live switching ------------


def test_selector_routes_native_and_mlx_through_build_selector(monkeypatch):
    """The production selector returns the on-device providers for their ids
    (so chat AND summaries get them with no special-casing)."""
    from loqui_sidecar.providers import build_selector

    monkeypatch.delenv("LOQUI_FAKE_CHAT", raising=False)
    select = build_selector()
    assert isinstance(select(ProviderConfig(provider="native")), NativeChatProvider)
    assert isinstance(select(ProviderConfig(provider="mlx")), BundledMlxProvider)


def test_windows_fallback_native_unavailable_errors_actionably(monkeypatch):
    """On Windows / unbundled there is no helper binary: the native provider builds
    but raises an actionable error at stream time (the fallback signal), so the
    selector + handler degrade gracefully instead of crashing."""
    # Simulate "no helper binary" regardless of host.
    monkeypatch.setattr(
        "loqui_sidecar.providers.native_provider._default_subprocess_factory",
        lambda: None,
    )
    provider = NativeChatProvider()  # no explicit factory -> default (now None)
    with pytest.raises(ChatProviderError) as exc:
        list(provider.stream_chat(_messages(), ProviderConfig(provider="native")))
    assert "macos" in str(exc.value).lower() or "unavailable" in str(exc.value).lower()


def test_switching_provider_takes_effect_per_request_without_restart(monkeypatch):
    """Switching is a per-request selector call (chat is a live WS request; the
    summary uses the next job's config) — no restart. A selector resolving each
    config independently proves a single process serves different providers."""
    from loqui_sidecar.providers import build_selector

    monkeypatch.delenv("LOQUI_FAKE_CHAT", raising=False)
    select = build_selector()

    first = select(ProviderConfig(provider="native"))
    second = select(ProviderConfig(provider="mlx", native_model="qwen2.5-3b"))
    assert first.name == "native"
    assert second.name == "mlx:qwen2.5-3b"
    # Same selector instance, different providers back-to-back -> live switching.


# --- WARM helper lifecycle: reuse / respawn / idle / serialization ------------


def test_warm_helper_reused_across_two_chat_turns_single_spawn():
    """The big latency win: two chat turns REUSE one spawned+handshaked helper —
    a single spawn and a single summaryStart, not a cold spawn per turn. Providers
    are rebuilt per request by the selector, so this must hold across DISTINCT
    provider instances sharing the same (engine, model)."""
    factory = SpawningFactory()

    out1 = "".join(
        NativeChatProvider(helper_factory=factory).stream_chat(
            _messages("first?"), ProviderConfig(provider="native")
        )
    )
    out2 = "".join(
        NativeChatProvider(helper_factory=factory).stream_chat(
            _messages("second?"), ProviderConfig(provider="native")
        )
    )

    assert out1 and out2
    assert factory.spawns == 1  # one process served both turns
    helper = factory.helpers[0]
    # Exactly one handshake, two generates, zero per-turn stops (warm).
    types = [m["type"] for m in helper.sent]
    assert types == ["summaryStart", "summaryGenerate", "summaryGenerate"]
    assert helper.closed is False


def test_warm_helper_respawns_and_retries_after_death():
    """A reused helper that has died (crashed / OS-reaped) must NOT fail the user's
    message: the pool respawns transparently and retries once on a fresh helper."""
    # First spawn dies on generate (EOF); second spawn works.
    factory = SpawningFactory(
        configure=lambda i: {"die_on_generate": True} if i == 0 else {"text": "recovered"}
    )
    provider = NativeChatProvider(helper_factory=factory)

    out = "".join(provider.stream_chat(_messages(), ProviderConfig(provider="native")))

    assert out == "recovered"  # the retry on the fresh helper produced the answer
    assert factory.spawns == 2  # respawned exactly once
    assert factory.helpers[0].closed is True  # the dead one was torn down


def test_warm_helper_idle_timeout_shuts_down(monkeypatch):
    """After the idle timeout the reaper tears the warm helper down (so an idle
    process, e.g. after a chat session or a one-shot summary, is reclaimed)."""
    monkeypatch.setenv(native_mod._IDLE_TIMEOUT_ENV, "0.05")
    helper = FakeSummaryHelper(text="ok")
    provider = NativeChatProvider(helper_factory=_factory(helper))

    list(provider.stream_chat(_messages(), ProviderConfig(provider="native")))
    assert helper.closed is False  # still warm right after the turn

    deadline = time.time() + 2.0
    while time.time() < deadline and not helper.closed:
        time.sleep(0.02)
    assert helper.closed is True  # idle reaper reclaimed it
    assert helper.sent[-1]["type"] == "summaryStop"  # clean teardown


def test_idle_timeout_zero_disables_warm_pool(monkeypatch):
    """A <= 0 idle timeout disables the warm pool: each turn spawns + tears down its
    own helper (the pre-warm-pool behavior, a safe fallback)."""
    monkeypatch.setenv(native_mod._IDLE_TIMEOUT_ENV, "0")
    factory = SpawningFactory()

    for ask in ("a?", "b?"):
        list(
            NativeChatProvider(helper_factory=factory).stream_chat(
                _messages(ask), ProviderConfig(provider="native")
            )
        )
    # With the pool disabled each fully-consumed turn spawned + tore down its own
    # helper immediately (no warm reuse): two spawns, both closed.
    assert factory.spawns == 2
    assert all(h.closed for h in factory.helpers)


def test_warm_helper_serializes_concurrent_generations():
    """One in-flight generation at a time: the warm helper's lock serializes two
    threads hitting the same (engine, model), so their protocol writes never
    interleave on one stdio channel."""
    barrier_hits: list[str] = []
    order_lock = threading.Lock()

    class _SlowHelper(FakeSummaryHelper):
        def send_line(self, line: str) -> None:  # type: ignore[override]
            import json as _json

            mtype = _json.loads(line).get("type")
            if mtype == "summaryGenerate":
                with order_lock:
                    barrier_hits.append("enter")
                time.sleep(0.05)
                with order_lock:
                    barrier_hits.append("exit")
            super().send_line(line)

    helper = _SlowHelper(text="x")
    provider = NativeChatProvider(helper_factory=_factory(helper))

    def _run():
        list(provider.stream_chat(_messages(), ProviderConfig(provider="native")))

    t1 = threading.Thread(target=_run)
    t2 = threading.Thread(target=_run)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Serialized: the two generations do not overlap -> enter/exit are paired, never
    # enter,enter,exit,exit.
    assert barrier_hits == ["enter", "exit", "enter", "exit"]


def test_shutdown_warm_helpers_tears_down_all():
    """shutdown_warm_helpers() (atexit / meeting-end) frees every warm process."""
    h_native = FakeSummaryHelper(text="n")
    h_mlx = FakeSummaryHelper(text="m")
    list(
        NativeChatProvider(helper_factory=_factory(h_native)).stream_chat(
            _messages(), ProviderConfig(provider="native")
        )
    )
    list(
        BundledMlxProvider(
            ProviderConfig(provider="mlx", native_model="qwen"),
            helper_factory=_factory(h_mlx),
        ).stream_chat(_messages(), ProviderConfig(provider="mlx", native_model="qwen"))
    )
    assert not h_native.closed and not h_mlx.closed  # both warm

    shutdown_warm_helpers()
    assert h_native.closed and h_mlx.closed  # both torn down


# --- DEPTH: the thoroughness instruction rides the SYSTEM (instructions) channel


def test_depth_instruction_on_system_channel():
    """The handler must put the 'answer thoroughly / in depth' guidance in the
    SYSTEM message so split_system_user delivers it on Apple FM's instructions
    channel (a far stronger signal than an inlined blob)."""
    from loqui_sidecar.providers.handler import build_context_message
    from loqui_sidecar.providers.transcript import FsTranscriptReader

    class _Reader(FsTranscriptReader):
        def read(self, meeting_id: str, variant: str = "live") -> str:  # type: ignore[override]
            return "[00:00:00] You said: we should ship Friday."

    ctx = build_context_message(_Reader(), "m1")
    assert ctx is not None and ctx.role == "system"
    # Include a user turn (as the handler always does) so split_system_user routes
    # the grounding/instructions to the SYSTEM channel and the ask to the USER one.
    user = ChatMessage(role="user", content="What did we decide?")
    system, user_prompt = native_mod.split_system_user([ctx, user])
    # The depth directive lands on the instructions channel, with concrete guidance.
    low = system.lower()
    assert "depth" in low or "thorough" in low
    assert "one-line" in low or "one line" in low or "several" in low
    # The ask rides as the user prompt, not the instructions.
    assert user_prompt == "What did we decide?"
