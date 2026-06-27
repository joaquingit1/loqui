"""PRD-10 — native on-device summary/chat providers behind the injectable helper.

Hermetic: a FAKE helper scripts the documented summary line/JSON protocol (NO
Swift binary, NO Apple model, NO MLX, NO network), so the protocol parsing, the
text mapping, the error mapping, and the read-only invariant are all verified on
Windows. The real Swift compile + the real Apple Foundation Models / MLX run are
Mac/CI-only (see ``test_native_summary_real.py``, skipped here).
"""

from __future__ import annotations

import pytest

from ._summary_helpers import FakeSummaryHelper
from ._summary_helpers import helper_factory as _factory

from loqui_sidecar.providers.native_provider import (
    BundledMlxProvider,
    NativeChatProvider,
    mlx_factory,
    native_factory,
    probe_summary_capabilities,
)
from loqui_sidecar.providers.types import (
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    ProviderConfig,
)


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
    # The helper saw a start (with the apple-foundation engine), a generate, then a stop.
    types = [m["type"] for m in helper.sent]
    assert types == ["summaryStart", "summaryGenerate", "summaryStop"]
    assert helper.sent[0]["engine"] == "apple-foundation"
    # The transcript context rides on the SYSTEM channel (-> session instructions),
    # the ask rides as the USER prompt — both reach the helper.
    assert "<transcript>" in helper.sent[1]["system"]
    assert "Summarize the meeting." in helper.sent[1]["prompt"]
    assert helper.closed is True


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
