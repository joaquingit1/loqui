"""Opt-in REAL native on-device summary test (PRD-10).

Skipped everywhere except macOS with the opt-in flag set, so the hermetic gate
(Windows/CI without Apple Intelligence) never spawns the Swift helper or loads a
model. Run on a Mac with the helper built + Apple Intelligence / MLX available:

    LOQUI_RUN_NATIVE_SUMMARY=1 LOQUI_ASR_HELPER_BIN=/path/to/loqui-asr-helper \
        uv run pytest -q sidecar/tests/test_native_summary_real.py

It exercises the FULL stack: the real ``loqui-asr-helper`` binary, the real Apple
Foundation Models (or NaturalLanguage fallback) summary engine, and the read-only
invariant against a real on-disk transcript.
"""

from __future__ import annotations

import os
import sys

import pytest

_ENABLED = sys.platform == "darwin" and os.environ.get("LOQUI_RUN_NATIVE_SUMMARY") == "1"

pytestmark = pytest.mark.skipif(
    not _ENABLED,
    reason="real native summary test runs only on macOS with LOQUI_RUN_NATIVE_SUMMARY=1",
)


def test_real_native_summary_is_readonly(tmp_path, monkeypatch):
    from loqui_sidecar.providers import transcript as transcript_mod
    from loqui_sidecar.providers.native_provider import (
        NativeChatProvider,
        probe_summary_capabilities,
    )
    from loqui_sidecar.providers.transcript import FsTranscriptReader
    from loqui_sidecar.providers.types import ProviderConfig
    from loqui_sidecar.postprocess.summary import summarize

    engines = probe_summary_capabilities()
    if "apple-foundation" not in engines and "apple-nl" not in engines:
        pytest.skip(f"no native summary engine available (probe: {engines})")

    root = tmp_path / "Loqui"
    root.mkdir()
    monkeypatch.setenv(transcript_mod.DATA_DIR_ENV, str(root))
    mdir = root / "meetings" / "m1"
    mdir.mkdir(parents=True)
    live = mdir / "transcript.live.md"
    live.write_text(
        "You: We decided to ship on Friday.\nThey: I'll write the runbook.\n",
        encoding="utf-8",
    )
    before = live.read_bytes()

    provider = NativeChatProvider(ProviderConfig(provider="native"))
    summary = summarize(
        "m1", provider, ProviderConfig(provider="native"), reader=FsTranscriptReader()
    )

    assert summary.tldr or summary.decisions or summary.action_items or summary.topics
    assert live.read_bytes() == before  # the AI never edited the transcript
