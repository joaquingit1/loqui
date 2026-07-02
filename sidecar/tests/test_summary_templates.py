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
    NOTETAKER_PROMPT,
    SUMMARY_INSTRUCTION,
    TEMPLATE_PLACEHOLDER,
    _looks_like_prompt_echo,
    _parse_summary,
    _strip_speaker_labels,
    build_summary_messages,
    summarize,
)
from loqui_sidecar.providers import (
    FAKE_CHAT_ENV,
    ChatMessage,
    ChatProviderError,
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
    """No template -> a SYSTEM message carrying the notetaker prompt + a USER turn
    carrying the read-only <transcript> and the "write the notes" ask."""
    _seed(data_dir, "m1")
    reader = FsTranscriptReader()
    messages = build_summary_messages("m1", ProviderConfig(provider="fake"), reader)
    assert messages[0].role == "system"
    # The system message LEADS with the notetaker prompt (an explicit-language
    # directive may follow when the transcript language is detectable).
    assert messages[0].content.startswith(SUMMARY_INSTRUCTION)  # == NOTETAKER_PROMPT
    assert "<transcript>" not in messages[0].content
    assert messages[-1].role == "user" and "<transcript>" in messages[-1].content


def test_detect_transcript_language():
    from loqui_sidecar.postprocess.summary import detect_transcript_language as d

    assert (
        d(
            "bueno acá estamos haciendo una prueba de las cosas que tenemos que terminar para la semana en la empresa con el equipo"
        )
        == "Spanish"
    )
    assert (
        d(
            "the meeting focused on the things that we have to do for the week and the team agreed to ship the product with new features"
        )
        == "English"
    )
    assert (
        d(
            "bom estamos aqui fazendo um teste das coisas que temos que terminar para a semana na empresa com a equipe não"
        )
        == "Portuguese"
    )
    # Too short / ambiguous -> None (falls back to the generic rule).
    assert d("ok sure") is None


class _FakeReader:
    def __init__(self, text: str):
        self._text = text

    def read(self, meeting_id, variant="live"):  # noqa: ARG002
        return self._text


def test_default_flow_names_the_transcript_language_explicitly():
    """A Spanish transcript -> the system message tells the model to write in
    Spanish explicitly (so the small on-device model doesn't default to English)."""
    reader = _FakeReader(
        "bueno acá estamos haciendo una prueba de producto de las cosas que tenemos "
        "que terminar para la semana que viene en la empresa con el equipo de operaciones"
    )
    messages = build_summary_messages("m1", ProviderConfig(provider="fake"), reader)
    system = messages[0].content
    assert "in Spanish" in system and "NON-NEGOTIABLE" in system

    # An English transcript names English (and never demands a translation).
    reader_en = _FakeReader(
        "the meeting focused on the things that we have to do for the week and the team "
        "agreed to ship the product with the new features and review the budget"
    )
    sys_en = build_summary_messages("m1", ProviderConfig(provider="fake"), reader_en)[0].content
    assert "in English" in sys_en


def test_default_flow_does_not_inject_speaker_legend_or_relabel():
    """The default summary grounding does NOT inject [ME]/[OTHER] tags or a speaker
    legend — on the small on-device model that pushed it to COPY the transcript
    verbatim and echo the labels. The system is just the notetaker prompt (+ the
    language directive); the transcript keeps its ORIGINAL "You said:"/"They said:"
    labels. (Chat keeps the [ME]/[OTHER] legend — strong models handle it.)"""
    reader = _FakeReader(
        "[00:00:00] You said: hola que tal\n"
        "[00:00:05] They said: todo bien gracias por la actualización del proyecto\n"
    )
    messages = build_summary_messages("m1", ProviderConfig(provider="fake"), reader)

    system = messages[0].content
    # NOTETAKER_PROMPT still leads (the existing startswith assertion must hold).
    assert system.startswith(SUMMARY_INSTRUCTION)
    # NO [ME]/[OTHER] legend in the summary system message.
    assert "SPEAKER ATTRIBUTION" not in system and "[ME]" not in system

    user = messages[-1].content
    # The transcript keeps its ORIGINAL labels (NOT relabeled to [ME]/[OTHER]).
    assert "You said:" in user and "They said:" in user
    assert "[ME]" not in user and "[OTHER]" not in user


def test_echo_detection_catches_transcript_echo_but_not_real_summary():
    """A transcript echo (speaker-label / timestamped lines) is rejected; a clean
    abstractive markdown summary is not."""
    echo = (
        "# Resumen\n"
        "- [ME] dijo: hola que tal\n"
        "- [OTHER] said: todo bien gracias\n"
        "- [00:00:12] You said: seguimos la semana que viene\n"
    )
    assert _looks_like_prompt_echo(echo) is True

    good = (
        "# Planificación de lanzamiento\n\n"
        "## Objetivo\n- Estimar el lanzamiento del módulo para fin de septiembre.\n"
        "## Seguimiento\n- Revisar el progreso semanalmente con el equipo.\n"
    )
    assert _looks_like_prompt_echo(good) is False


def test_strip_speaker_labels_removes_internal_tokens():
    """As a last resort, leaked speaker labels are stripped from the summary."""
    leaked = (
        "- [ME] said: cerramos el viernes\n"
        "- [OTHER]: yo escribo el runbook\n"
        "- You said: revisamos el presupuesto\n"
        "- Punto normal sin etiqueta\n"
    )
    out = _strip_speaker_labels(leaked)
    assert "[ME]" not in out and "[OTHER]" not in out
    assert "You said:" not in out
    # The actual content survives.
    assert "cerramos el viernes" in out
    assert "Punto normal sin etiqueta" in out


# --- the assistant-style sections (Key Takeaways / Action Items / Deliverables) --

# A realistic notetaker output in the new shape: the title, topic sections, then the
# standing sections in order. Everything after the title is markdown OVERVIEW.
NEW_FORMAT_SUMMARY = (
    "# Sarah and John Finalize Q2 Budget\n\n"
    "## Budget decision\n"
    "- The Q2 budget was set at $1.2M, up 8% to fund two new hires.\n"
    "- Marketing's request was deferred to Q3 pending the pipeline review.\n\n"
    "## Key Takeaways\n"
    "- Q2 budget is locked at $1.2M; hiring can start immediately.\n"
    "- Marketing spend is on hold until the Q3 pipeline review.\n\n"
    "## Your Action Items\n"
    "- Send the signed budget to finance by Friday.\n"
    "- Kick off the two engineering reqs with recruiting this week.\n\n"
    "## Team Action Items\n"
    "- Sarah schedules the Q3 pipeline review before deciding on marketing.\n\n"
    "## Deliverables\n"
    "- Signed Q2 budget doc — owner: you, due Friday.\n"
)


def test_prompt_carries_the_standing_sections_and_translates_headers():
    """The notetaker prompt instructs the model to emit the assistant-style
    standing sections (takeaways / action items / deliverables) and to translate
    their headers into the meeting's language."""
    assert "## Key Takeaways" in NOTETAKER_PROMPT
    assert "## Your Action Items" in NOTETAKER_PROMPT
    assert "## Team Action Items" in NOTETAKER_PROMPT
    assert "## Deliverables" in NOTETAKER_PROMPT
    # The recorder-vs-others attribution signal + the omit-empty-sections rule.
    assert "RECORDER" in NOTETAKER_PROMPT and '"You"' in NOTETAKER_PROMPT
    assert "OMIT" in NOTETAKER_PROMPT
    # Headers must be written in the meeting's language too (translate the headers).
    assert "Translate the section headers" in NOTETAKER_PROMPT
    # The safeguards we must never lose.
    assert "NEVER translate the meeting into" in NOTETAKER_PROMPT
    assert 'NEVER use "Speaker 0"' in NOTETAKER_PROMPT
    assert "Begin your reply with the `# ` title line" in NOTETAKER_PROMPT


def test_parse_new_format_keeps_all_sections_in_overview():
    """The new assistant-style shape parses like any markdown doc: the leading H1
    is the title; every section (topics + takeaways + action items + deliverables)
    stays in the markdown overview."""
    s = _parse_summary(NEW_FORMAT_SUMMARY, meeting_id="m1", provider="anthropic", model="claude")

    assert s.title == "Sarah and John Finalize Q2 Budget"
    # The title line is stripped; the body begins at the first topic section.
    assert s.overview.startswith("## Budget decision")
    assert "# Sarah and John" not in s.overview
    for header in ("## Key Takeaways", "## Your Action Items", "## Team Action Items"):
        assert header in s.overview
    assert "## Deliverables" in s.overview
    # The recorder's own task survives verbatim (it becomes searchable via overview).
    assert "Send the signed budget to finance by Friday." in s.overview
    # New shape does NOT populate the legacy JSON fields.
    assert s.tldr == "" and s.decisions == [] and s.action_items == [] and s.topics == []


def test_parse_new_format_omits_empty_sections_cleanly():
    """A meeting where the recorder took on nothing (and nothing was promised) omits
    the Your Action Items / Deliverables sections — the doc still parses fine and
    the remaining sections are intact."""
    partial = (
        "# Weekly Engineering Sync\n\n"
        "## Release status\n"
        "- Backend is on track for the Friday cut.\n\n"
        "## Key Takeaways\n"
        "- The release is a go for Friday.\n\n"
        "## Team Action Items\n"
        "- QA runs the regression suite on Thursday.\n"
    )
    s = _parse_summary(partial, meeting_id="m2", provider="fake", model="fake")

    assert s.title == "Weekly Engineering Sync"
    assert "## Your Action Items" not in s.overview
    assert "## Deliverables" not in s.overview
    # No stray "none" filler and the real sections are present.
    assert "none" not in s.overview.lower()
    assert "## Key Takeaways" in s.overview and "## Team Action Items" in s.overview


def test_new_format_summary_is_not_flagged_as_prompt_echo():
    """A well-formed assistant-style summary — including verb-first action-item
    bullets and translated (Spanish) standing-section headers — is NOT mistaken for
    a prompt/transcript echo."""
    assert _looks_like_prompt_echo(NEW_FORMAT_SUMMARY) is False

    spanish = (
        "# Sarah y Juan Cierran el Presupuesto Q2\n\n"
        "## Decisión de presupuesto\n"
        "- El presupuesto Q2 quedó en $1.2M para dos contrataciones nuevas.\n\n"
        "## Puntos Clave\n"
        "- El presupuesto está cerrado; se puede contratar de inmediato.\n\n"
        "## Tus Tareas\n"
        "- Enviar el presupuesto firmado a finanzas el viernes.\n\n"
        "## Tareas del Equipo\n"
        "- Sarah agenda la revisión del pipeline de Q3.\n"
    )
    assert _looks_like_prompt_echo(spanish) is False


def test_calendar_context_block_injects_participant_names(data_dir):
    """When a MeetingContext with attendees is passed, the system message carries a
    CALENDAR MEETING CONTEXT block with the participant names (so the prompt can
    use real names instead of Speaker N)."""
    from loqui_sidecar.postprocess.request import Attendee, MeetingContext

    _seed(data_dir, "m1")
    ctx = MeetingContext(
        title="Q2 Budget",
        platform="google-meet",
        started_at="2026-06-26T15:00:00Z",
        attendees=[Attendee(name="Sarah Lee"), Attendee(name="John Park")],
    )
    messages = build_summary_messages(
        "m1", ProviderConfig(provider="fake"), FsTranscriptReader(), ctx
    )
    system = messages[0].content
    assert "CALENDAR MEETING CONTEXT:" in system
    assert "Sarah Lee" in system and "John Park" in system
    assert "Q2 Budget" in system

    # No context -> no block. (The prompt itself mentions "CALENDAR MEETING
    # CONTEXT" without a colon; the injected block header has the colon.)
    plain = build_summary_messages("m1", ProviderConfig(provider="fake"), FsTranscriptReader())
    assert "CALENDAR MEETING CONTEXT:" not in plain[0].content
    assert "Sarah Lee" not in plain[0].content


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


class _EchoProvider:
    """A degraded provider that echoes the instruction back (mimics an extractive
    engine summarizing the prompt) instead of generating a summary."""

    name = "echo"

    def stream_chat(self, messages, config, api_key=None):  # type: ignore[no-untyped-def]
        # A degraded extractive engine reproduces the notetaker instruction text
        # instead of summarizing — the echo guard must reject this.
        yield "You are an expert meeting notetaker. One idea = one bullet."


def test_echoed_prompt_is_rejected_as_failed_summary(data_dir):
    """A real provider that returns the echoed prompt/instruction must NOT become
    a summary — summarize() raises so the runner marks the stage as an error
    rather than rendering the instruction text as the TL;DR."""
    _seed(data_dir, "m1")
    with pytest.raises(ChatProviderError):
        summarize(
            "m1",
            _EchoProvider(),
            ProviderConfig(provider="anthropic"),
            reader=FsTranscriptReader(),
        )


def test_native_provider_has_no_transcript_writer():
    """Structurally: the native provider has no write/store/file-handle surface —
    only the read-only ChatProvider seam (name + stream_chat, plus the inert
    ``engine`` marker)."""
    provider = NativeChatProvider(helper_factory=_factory(FakeSummaryHelper()))
    public = {n for n in dir(provider) if not n.startswith("_")}
    assert "stream_chat" in public and "name" in public
    for forbidden in ("write", "save", "patch", "put", "delete", "append", "store"):
        assert not any(forbidden in n.lower() for n in public)
