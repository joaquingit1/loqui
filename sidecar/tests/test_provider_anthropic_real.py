"""Opt-in, best-effort REAL Anthropic streaming smoke (PRD-4).

This is NOT part of the default unit gate. It is skipped cleanly unless
``ANTHROPIC_API_KEY`` is set in the environment. When set, it makes ONE tiny real
streamed call through :class:`AnthropicProvider` (the official ``anthropic`` SDK,
adaptive thinking, no sampling params) and asserts the stream produced non-empty
text. Keep ``max_tokens`` small via a terse prompt; the provider pins
``max_tokens=4096`` and ``thinking={"type":"adaptive"}`` per the PRD contract.

Run (only when you intend to spend a few tokens)::

    ANTHROPIC_API_KEY=sk-... uv run pytest -q tests/test_provider_anthropic_real.py
"""

from __future__ import annotations

import os

import pytest

from loqui_sidecar.providers import AnthropicProvider, ChatMessage, ProviderConfig

pytestmark = pytest.mark.skipif(
    not os.getenv("ANTHROPIC_API_KEY"),
    reason="real Anthropic smoke is opt-in; set ANTHROPIC_API_KEY to run",
)


def test_real_anthropic_streams_nonempty_text():
    api_key = os.environ["ANTHROPIC_API_KEY"]
    provider = AnthropicProvider()  # real SDK path (no injected factory)

    messages = [
        ChatMessage(
            role="system",
            content="<transcript>\nAlice: we must ship the audit log by Friday.\n</transcript>",
        ),
        ChatMessage(role="user", content="In one short sentence, what is the action item?"),
    ]
    # Use the cheapest/fastest pinned model for the smoke.
    config = ProviderConfig(provider="anthropic", model="claude-haiku-4-5")

    deltas = list(provider.stream_chat(messages, config, api_key=api_key))
    text = "".join(deltas)
    assert text.strip(), "expected a non-empty streamed answer"
    assert len(deltas) >= 1
