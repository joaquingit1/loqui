"""Provider registry / factory (PRD-4 build unit).

Wires the three real provider build units (Anthropic / Ollama / agent-CLI) into a
single :data:`ProviderSelector` via the Foundation seam
:func:`make_provider_selector`. ``app.py`` (or any caller) gets a selector keyed by
``providerConfig.provider`` that returns the right :class:`ChatProvider`.

``LOQUI_FAKE_CHAT`` (and ``providerConfig.provider == "fake"``) still force the
hermetic :class:`FakeChatProvider`, so selecting through this registry stays safe
in the unit gate + smoke.

The factories are imported lazily inside :func:`build_selector` so that merely
importing this module (or the package) never imports ``anthropic`` / ``httpx`` —
the default hermetic gate, which uses the fake provider, pulls in no heavy/optional
dependency at collection time.
"""

from __future__ import annotations

from .handler import ProviderSelector, make_provider_selector


def build_selector() -> ProviderSelector:
    """Return a :data:`ProviderSelector` wired to all real provider factories.

    Lazy imports keep the contract package import-light and the fake-only gate
    hermetic.
    """
    from .agent_cli_provider import agent_cli_factory
    from .anthropic_provider import anthropic_factory
    from .ollama_provider import ollama_factory

    return make_provider_selector(
        anthropic_factory=anthropic_factory,
        ollama_factory=ollama_factory,
        agent_cli_factory=agent_cli_factory,
    )


def default_selector() -> ProviderSelector:
    """Alias for :func:`build_selector` (the production selector)."""
    return build_selector()
