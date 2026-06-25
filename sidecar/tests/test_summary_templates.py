"""PRD-10 — custom summary prompt templates + native-provider summaries.

Hermetic (NO network/key/model): seeds a meeting under a temp ``LOQUI_DATA_DIR``,
runs the PRD-5 summary path with (a) a chosen custom template threaded through the
provider config and (b) a fake NATIVE on-device provider (the summary helper
protocol scripted by a fake helper). The headline assertion is the read-only
invariant: ``transcript.live.md`` / ``transcript.jsonl`` are byte-identical after a
native-provider summary, and the provider has no write path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator, Optional

import pytest

from loqui_sidecar.postprocess import (
    FAKE_DIARIZER_ENV,
    POSTPROCESS_DONE_EVENT,
    FakeDiarizer,
    PostProcessRequest,
    run_postprocess,
)
from loqui_sidecar.postprocess.summary import (
    SUMMARY_INSTRUCTION,
    TEMPLATE_PLACEHOLDER,
    build_summary_messages,
    summarize,
)
from loqui_sidecar.providers import (
    FAKE_CHAT_ENV,
    ChatMessage,
    ProviderConfig,
)
from loqui_sidecar.providers import transcript as transcript_mod
from loqui_sidecar.providers.native_provider import NativeChatProvider
from loqui_sidecar.providers.transcript import FsTranscriptReader

# Reuse the shared fake summary helper.
from ._summary_helpers import FakeSummaryHelper
from ._summary_helpers import helper_factory as _factory

SAMPLE_LIVE = (
    "## Live transcript\n\n"
    "You: We agreed to ship the Falcon-7 release on Friday.\n"
    "They: I'll own the migration. Action item: write the runbook.\n"
)

SAMPLE_RECORDS = [
    {"segId": "s0", "source": "mic", "tStart": 0.0, "tEnd": 2.5, "text": "hello team"},
    {"segId": "s1", "source": "system", "tStart": 0.5, "tEnd": 2.8, "text": "remote one"},
]


@pytest.fixture
def data_dir(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "Loqui"
    root.mkdir()
    monkeypatch.setenv(transcript_mod.DATA_DIR_ENV, str(root))
    monkeypatch.delenv(FAKE_CHAT_ENV, raising=False)
    monkeypatch.delenv(FAKE_DIARIZER_ENV, raising=False)
    return root


def _seed(data_dir: Path, meeting_id: str, *, live: str = SAMPLE_LIVE) -> Path:
    mdir = data_dir / "meetings" / meeting_id
    mdir.mkdir(parents=True, exist_ok=True)
    (mdir / "transcript.live.md").write_text(live, encoding="utf-8")
    (mdir / "transcript.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in SAMPLE_RECORDS), encoding="utf-8"
    )
    return mdir


def _collect_emit():
    events: list[tuple[str, dict]] = []

    def emit(event: str, data: dict) -> None:
        events.append((event, data))

    return events, emit


def _done(events) -> dict:
    dones = [d for e, d in events if e == POSTPROCESS_DONE_EVENT]
    assert len(dones) == 1
    return dones[0]


# --- A recording provider so we can inspect the EXACT prompt the template built --


class _RecordingProvider:
    """A ChatProvider that records the messages it received + echoes a fixed JSON
    so the summary parses. Lets a test assert the chosen template drove the prompt."""

    name = "recording"

    def __init__(self) -> None:
        self.messages: list[ChatMessage] = []

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        self.messages = list(messages)
        yield '{"tldr": "ok", "decisions": [], "action_items": [], "topics": []}'


# --- default templates (the three named slots PRD-10 ships) -------------------

# Mirror of the default template TEXT shipped in @loqui/shared (DEFAULT_SUMMARY_
# TEMPLATES). Kept as constants here so the Python summary path can be tested
# against the same prompts the UI offers.
TLDR_TEMPLATE = (
    "Give a 2-3 sentence TL;DR of this meeting. Use ONLY the transcript.\n\n" "{transcript}"
)
DECISIONS_TEMPLATE = "List the key decisions made in this meeting:\n\n{transcript}"
ACTION_ITEMS_TEMPLATE = "Extract the action items (with owners) from:\n\n{transcript}"


def test_default_flow_uses_builtin_instruction(data_dir):
    """No template -> the built-in SUMMARY_INSTRUCTION + <transcript> context
    (byte-identical to pre-PRD-10 behavior)."""
    _seed(data_dir, "m1")
    reader = FsTranscriptReader()
    messages = build_summary_messages("m1", ProviderConfig(provider="fake"), reader)
    assert messages[0].role == "system" and "<transcript>" in messages[0].content
    assert messages[-1].content == SUMMARY_INSTRUCTION


def test_template_with_placeholder_owns_the_prompt(data_dir):
    """A template containing {transcript} is the single user turn with the
    read-only transcript spliced in (no separate context message)."""
    _seed(data_dir, "m1")
    reader = FsTranscriptReader()
    cfg = ProviderConfig(provider="fake", summary_template=TLDR_TEMPLATE)
    messages = build_summary_messages("m1", cfg, reader)

    assert len(messages) == 1
    assert messages[0].role == "user"
    assert "2-3 sentence TL;DR" in messages[0].content
    assert "Falcon-7" in messages[0].content  # the transcript was spliced in
    assert TEMPLATE_PLACEHOLDER not in messages[0].content  # placeholder replaced


def test_template_without_placeholder_keeps_transcript_context(data_dir):
    """A template lacking {transcript} keeps the read-only <transcript> context
    system message + uses the template as the instruction."""
    _seed(data_dir, "m1")
    reader = FsTranscriptReader()
    cfg = ProviderConfig(provider="fake", summary_template="Just the action items, please.")
    messages = build_summary_messages("m1", cfg, reader)

    assert messages[0].role == "system" and "<transcript>" in messages[0].content
    assert messages[-1].content == "Just the action items, please."


def test_chosen_template_flows_into_summarize(data_dir):
    """The chosen template reaches the provider via summarize()."""
    _seed(data_dir, "m1")
    provider = _RecordingProvider()
    cfg = ProviderConfig(provider="recording", summary_template=DECISIONS_TEMPLATE)
    summarize("m1", provider, cfg, reader=FsTranscriptReader())

    prompt = provider.messages[-1].content
    assert "key decisions" in prompt
    assert "Falcon-7" in prompt


def test_regenerating_with_a_different_template_changes_the_prompt(data_dir):
    """Selecting a different template on regenerate uses the new one."""
    _seed(data_dir, "m1")
    reader = FsTranscriptReader()

    p1 = _RecordingProvider()
    summarize(
        "m1",
        p1,
        ProviderConfig(provider="recording", summary_template=TLDR_TEMPLATE),
        reader=reader,
    )
    p2 = _RecordingProvider()
    summarize(
        "m1",
        p2,
        ProviderConfig(provider="recording", summary_template=ACTION_ITEMS_TEMPLATE),
        reader=reader,
    )

    assert "TL;DR" in p1.messages[-1].content
    assert "action items" in p2.messages[-1].content
    assert p1.messages[-1].content != p2.messages[-1].content


def test_default_templates_have_placeholder_and_are_distinct():
    templates = [TLDR_TEMPLATE, DECISIONS_TEMPLATE, ACTION_ITEMS_TEMPLATE]
    assert all(TEMPLATE_PLACEHOLDER in t for t in templates)
    assert len(set(templates)) == 3


# --- native provider end-to-end through the summary path ----------------------


def test_native_provider_produces_a_summary(data_dir):
    """A native on-device provider (fake helper) drives summarize() and yields a
    parseable summary."""
    _seed(data_dir, "m1")
    helper = FakeSummaryHelper(
        text='{"tldr": "Falcon-7 ships Friday", "decisions": ["ship Friday"], '
        '"action_items": [{"text": "write runbook", "owner": "They"}], "topics": ["release"]}'
    )
    provider = NativeChatProvider(helper_factory=_factory(helper))
    summary = summarize(
        "m1", provider, ProviderConfig(provider="native"), reader=FsTranscriptReader()
    )

    assert summary.tldr == "Falcon-7 ships Friday"
    assert summary.decisions == ["ship Friday"]
    assert summary.action_items[0].text == "write runbook"
    assert summary.provider == "native"
    assert summary.model == "native"  # the provider's name


# --- the READ-ONLY invariant for the native provider --------------------------


def test_transcript_byte_identical_after_native_summary(data_dir):
    """The headline invariant: after a full post-process run whose SUMMARY used a
    NATIVE on-device provider, the live + structured transcripts are byte-for-byte
    identical, and the derived summary.json is a SEPARATE file."""
    mdir = _seed(data_dir, "m1")
    live = mdir / "transcript.live.md"
    jsonl = mdir / "transcript.jsonl"
    live_before = live.read_bytes()
    jsonl_before = jsonl.read_bytes()

    helper = FakeSummaryHelper(
        text='{"tldr": "done", "decisions": [], "action_items": [], "topics": []}'
    )
    # Inject a selector that returns the native provider (fake helper) for "native".
    selector = lambda cfg: NativeChatProvider(helper_factory=_factory(helper))  # noqa: E731

    events, emit = _collect_emit()
    run_postprocess(
        PostProcessRequest(meeting_id="m1", config=ProviderConfig(provider="native")),
        emit,
        diarizer=FakeDiarizer(),
        selector=selector,
    )

    assert _done(events)["summary"] == "done"  # the native summary actually ran
    assert live.read_bytes() == live_before
    assert jsonl.read_bytes() == jsonl_before
    # The summary is a SEPARATE derived file — never the live transcript.
    assert (mdir / "summary.json").exists()
    summary_doc = json.loads((mdir / "summary.json").read_text(encoding="utf-8"))
    assert summary_doc["provider"] == "native"


def test_native_provider_has_no_transcript_writer():
    """Structurally: the native provider has no write/store/file-handle surface —
    only the read-only ChatProvider seam (name + stream_chat, plus the inert
    ``engine`` marker)."""
    provider = NativeChatProvider(helper_factory=_factory(FakeSummaryHelper()))
    public = {n for n in dir(provider) if not n.startswith("_")}
    assert "stream_chat" in public and "name" in public
    for forbidden in ("write", "save", "patch", "put", "delete", "append", "store"):
        assert not any(forbidden in n.lower() for n in public)
