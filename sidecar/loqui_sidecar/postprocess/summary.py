"""Summary seam (PRD-5) — generate the structured :class:`Summary` via the
PRD-4 provider layer, READ-ONLY over the transcript.

The summary REUSES the PRD-4 ``ChatProvider`` (no separate AI path, PRD-5 AC#5):
the same provider selection (Anthropic / Ollama / agent-CLI / fake) and the same
READ-ONLY transcript accessor. The provider receives the transcript as context
and yields text; the provider NEVER edits the transcript. A SEPARATE
summary-writer (see :mod:`loqui_sidecar.postprocess.writers`) persists the result
to ``summary.json``.

``summarize()`` asks the provider for a parseable JSON envelope and maps it onto
the structured :class:`Summary` fields (tldr / decisions / action_items /
topics). When the provider returns prose instead of JSON (e.g. the fake provider
or a non-compliant model), it degrades to putting the raw text in the TL;DR so
the summary stays non-empty + searchable.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Callable, Optional

from ..providers.handler import CONTEXT_CHAR_BUDGET, build_context_message
from ..providers.types import (
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    ProviderConfig,
    TranscriptReader,
)
from ..providers.transcript import default_transcript_reader
from ..lang import detect_language
from .types import ActionItem, Summary

logger = logging.getLogger("loqui_sidecar.postprocess.summary")

#: The system instruction for the summary provider — an expert meeting-notetaker
#: prompt that yields a markdown DOCUMENT (a title + a themed overview), NOT a JSON
#: envelope. :func:`_parse_summary` splits the leading ``# Title`` line off as the
#: title and keeps the rest as the markdown ``overview``. The native/on-device
#: providers receive this same text (the prompt is a parameter, not baked into the
#: Swift helper), and markdown is far more reliable for them than strict JSON.
NOTETAKER_PROMPT = (
    "You are an expert meeting notetaker. Your job is to turn the provided meeting "
    "transcript into the notes the user wishes they'd taken themselves — clear, "
    "structured, and complete enough that they never need to replay the recording. "
    "Capture what was decided, what matters, and what happens next. Be faithful to "
    "what was actually said: never invent details, soften them into vague "
    "generalities, or add commentary that wasn't in the conversation.\n\n"
    "LANGUAGE — THE MOST IMPORTANT RULE: write the ENTIRE summary (the title, every "
    "section header, and every bullet) in the SAME LANGUAGE the meeting was held in, "
    "as seen in the transcript. If the transcript is in Spanish, write everything in "
    "Spanish; if French, in French; and so on. NEVER translate the meeting into "
    "English. Match the transcript's language exactly.\n\n"
    "CRITICAL: If CALENDAR MEETING CONTEXT is provided with participant names, you "
    "MUST use those names:\n"
    "- The meeting DEFINITELY happened between the named participants\n"
    '- NEVER use "Speaker 0", "Speaker 1", "Speaker 2", etc. when participant names '
    "are available\n"
    "- Match transcript speakers to participant names by carefully analyzing the "
    "conversation context\n"
    "- Use participant names throughout the title, overview, and all generated "
    "content\n"
    "- Use the scheduled meeting title as a strong signal for the title (but you may "
    "refine it based on the actual discussion)\n"
    "- Use the meeting platform and scheduled time to provide better context\n"
    "- If there are 2-3 participants with known names, naturally mention them in the "
    'title (e.g., "Sarah and John Discuss Q2 Budget", "Team Meeting with Alex, Maria, '
    'and Chris")\n\n'
    "OUTPUT FORMAT (follow exactly — output GitHub-flavored Markdown only; no JSON, "
    "no code fences, no preamble):\n"
    "- Line 1 is the TITLE, prefixed with '# ' (a single hash + space), then a blank "
    "line. Write a clear, compelling headline (≤ 10 words) in Title Case that "
    "captures the central topic and outcome, with a key noun + verb where possible "
    '(e.g., "# Team Finalizes Q2 Budget"). Include 2-3 participant names when known '
    'and relevant (e.g., "# John and Sarah Plan Marketing Campaign").\n'
    "- After the title comes the OVERVIEW: do NOT write a single dense paragraph. "
    "Structure it as topic-grouped notes a reader can skim in 15 seconds and still "
    "trust.\n"
    "- Group the meeting into 2-5 themed sections. Give each a short header as "
    "'## <Header>' (≤ 5 words) reflecting the actual topic discussed — never generic "
    'labels like "Discussion" or "Points". Use the participants\' real subject '
    "matter.\n"
    "- Under each header, write one '- ' bullet PER DISTINCT IDEA. One idea = one "
    "bullet. Do not pack two unrelated points into one bullet, and do not split a "
    "single idea across several bullets.\n"
    "- Each bullet is a self-contained paragraph (1-3 sentences): state the point in "
    "the first sentence, then add the supporting detail, reasoning, number, or "
    "example that was actually said. A bullet must make sense without reading the "
    "others.\n"
    "- Lead each bullet with the substance, not throat-clearing. Write \"Pricing "
    'moves to usage-based in Q3 to lift expansion revenue" — not "They talked about '
    'pricing."\n'
    "- Preserve concrete specifics verbatim where they matter: names, numbers, "
    "dates, dollar amounts, tools, and who committed to what.\n"
    "- Do not invent structure that isn't there. If the meeting only covers one "
    "topic, use one section. Never pad to hit a section or bullet count.\n"
    "- Order sections by importance to the user, not by chronology.\n\n"
    "Follow this EXACT shape (this example is English, but you must write in the "
    "transcript's own language):\n"
    "# Team Finalizes Q2 Budget\n\n"
    "## Budget decision\n"
    "- The Q2 budget was set at $1.2M, up 8% to fund two new hires.\n"
    "- Marketing's request was deferred to Q3 pending the pipeline review.\n\n"
    "## Next steps\n"
    "- Sarah sends the signed budget to finance by Friday.\n\n"
    "Now write the notes. Begin your reply with the `# ` title line and nothing "
    "before it."
)

#: Back-compat alias: older tests / call sites referenced SUMMARY_INSTRUCTION.
SUMMARY_INSTRUCTION = NOTETAKER_PROMPT


#: Name the transcript's language explicitly (see :mod:`loqui_sidecar.lang`) so a
#: small on-device model writes in it instead of defaulting to English. Aliased
#: under the historical name used by tests / this module.
detect_transcript_language = detect_language


def build_calendar_context_block(context: object) -> Optional[str]:
    """Render a ``MeetingContext`` into the CALENDAR MEETING CONTEXT block the
    notetaker prompt references, or None when there's nothing to add.

    ``context`` is a :class:`~loqui_sidecar.postprocess.request.MeetingContext`
    (duck-typed here to avoid an import cycle): ``.title``, ``.platform``,
    ``.started_at``, ``.attendees`` (each ``.name`` / ``.email``), and
    ``.has_content()``.
    """
    if context is None or not getattr(context, "has_content", lambda: False)():
        return None
    lines: list[str] = ["CALENDAR MEETING CONTEXT:"]
    title = getattr(context, "title", "")
    platform = getattr(context, "platform", "")
    started_at = getattr(context, "started_at", "")
    attendees = list(getattr(context, "attendees", []) or [])
    if title:
        lines.append(f"- Scheduled title: {title}")
    if platform:
        lines.append(f"- Platform: {platform}")
    if started_at:
        lines.append(f"- Scheduled time: {started_at}")
    names = [getattr(a, "name", "").strip() for a in attendees]
    names = [n for n in names if n]
    if names:
        lines.append(f"- Participants ({len(names)}): {', '.join(names)}")
    # Only worth emitting when there is at least one usable signal beyond the header.
    return "\n".join(lines) if len(lines) > 1 else None

#: The placeholder a custom summary prompt template (PRD-10) uses to mark where
#: the read-only transcript text is spliced in. Mirror of @loqui/shared
#: SUMMARY_TEMPLATE_PLACEHOLDER. A template MAY omit it — in which case the
#: handler-built ``<transcript>`` context system message is prepended exactly like
#: the default flow, so a template that just says "Give me action items" still
#: sees the transcript.
TEMPLATE_PLACEHOLDER = "{transcript}"


def _coerce_str_list(value: object) -> list[str]:
    """Best-effort coerce a parsed JSON value into a clean list[str]."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, str):
            s = item.strip()
        elif item is None:
            continue
        else:
            s = str(item).strip()
        if s:
            out.append(s)
    return out


def _coerce_action_items(value: object) -> list[ActionItem]:
    """Best-effort coerce a parsed JSON value into a list[ActionItem]."""
    if not isinstance(value, list):
        return []
    out: list[ActionItem] = []
    for item in value:
        if isinstance(item, str):
            text = item.strip()
            owner = None
        elif isinstance(item, dict):
            text = str(item.get("text", "")).strip()
            raw_owner = item.get("owner")
            owner = (
                str(raw_owner).strip() if isinstance(raw_owner, str) and raw_owner.strip() else None
            )
        else:
            continue
        if text:
            out.append(ActionItem(text=text, owner=owner))
    return out


def _extract_json_object(text: str) -> Optional[dict]:
    """Tolerantly pull a single JSON object out of ``text``.

    Handles a bare object, a ```` ```json ```` fenced block, or an object
    embedded in surrounding prose. Returns None when nothing parseable is found
    (the caller then falls back to a raw-text TL;DR).
    """
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else None
    if candidate is None:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            candidate = text[start : end + 1]
    if candidate is None:
        return None
    try:
        parsed = json.loads(candidate)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


#: Distinctive INSTRUCTION phrases that should never appear in a real summary.
#: If a provider's output contains one of these it echoed the prompt back (e.g. an
#: extractive engine summarizing the instruction text) instead of summarizing the
#: meeting — we reject that as a failed summary rather than rendering it.
_ECHO_MARKERS = (
    "expert meeting notetaker",
    "calendar meeting context",
    "output format (follow exactly",
    "one idea = one bullet",
    "respond with a single json",
    "<transcript>",
)


def _looks_like_prompt_echo(text: str) -> bool:
    """True when the provider output is clearly the echoed prompt/instruction.

    Defense in depth across providers: a real generative summary never reproduces
    the instruction verbatim, so the presence of these instruction-only phrases (or
    the rendered ``User:``-prefixed prompt) marks an echo we must not surface.
    """
    if not text:
        return False
    lowered = text.lower()
    if any(marker in lowered for marker in _ECHO_MARKERS):
        return True
    # The native helper renders the conversation as "User: …" lines; an extractive
    # echo therefore starts with that prefix (optionally bulleted).
    stripped = text.lstrip().lstrip("•").lstrip()
    return stripped.startswith("User:")


def _looks_like_json(text: str) -> bool:
    """True when the output is (or contains a fenced) JSON object — the legacy
    custom-template path. The default notetaker output is markdown prose (and the
    prompt forbids code fences), so we only attempt the JSON parse when the text
    opens as ``{`` or carries an explicit ```` ```json ```` fence — never just
    because a prose bullet happens to contain a brace."""
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return True
    return bool(re.search(r"```(?:json)?\s*\{", text))


def _split_title_overview(text: str) -> tuple[str, str]:
    """Split a markdown summary into (title, overview).

    The notetaker prompt emits the title as a leading ``# Title`` line; we strip
    that off and keep the remainder as the markdown overview. If no leading H1 is
    present we leave the title empty (so the meeting keeps its calendar/manual
    title) and treat the whole text as the overview.
    """
    lines = text.strip().splitlines()
    title = ""
    body_start = 0
    for i, line in enumerate(lines):
        if line.strip() == "":
            continue
        m = re.match(r"#\s+(.*\S)\s*$", line.strip())
        if m:
            title = m.group(1).strip()
            body_start = i + 1
        break  # only the FIRST non-empty line can be the title
    overview = "\n".join(lines[body_start:]).strip()
    return title, overview


def _parse_summary(text: str, meeting_id: str, provider: str, model: str) -> Summary:
    """Map the provider's streamed output onto a structured :class:`Summary`.

    Default path: the notetaker prompt yields a markdown document — split the
    leading ``# Title`` off as :attr:`Summary.title` and keep the rest as the
    markdown :attr:`Summary.overview`. Legacy/custom-template path: if the output
    is JSON, map it onto the legacy tldr/decisions/action_items/topics fields. A
    last-resort fallback puts the raw text in ``overview`` so the summary stays
    non-empty + searchable.
    """
    base = dict(meeting_id=meeting_id, provider=provider, model=model)

    # Legacy JSON path (custom templates that still request a JSON envelope).
    if _looks_like_json(text):
        parsed = _extract_json_object(text)
        if parsed is not None:
            title = str(parsed.get("title", "")).strip()
            overview = str(parsed.get("overview", "")).strip()
            tldr = str(parsed.get("tldr", "")).strip()
            decisions = _coerce_str_list(parsed.get("decisions"))
            action_items = _coerce_action_items(parsed.get("action_items"))
            topics = _coerce_str_list(parsed.get("topics"))
            if title or overview or tldr or decisions or action_items or topics:
                return Summary(
                    title=title,
                    overview=overview,
                    tldr=tldr,
                    decisions=decisions,
                    action_items=action_items,
                    topics=topics,
                    **base,
                )

    # Default markdown path.
    title, overview = _split_title_overview(text)
    if not overview:
        overview = text.strip()
    return Summary(title=title, overview=overview, **base)


def build_summary_messages(
    meeting_id: str,
    config: ProviderConfig,
    reader: TranscriptReader,
    context: object = None,
) -> list[ChatMessage]:
    """Build the provider ``messages`` for a summary request (READ-ONLY).

    Default flow (no custom template): a SYSTEM message carrying the expert
    :data:`NOTETAKER_PROMPT` — plus an injected CALENDAR MEETING CONTEXT block
    when ``context`` (a ``MeetingContext``) has content — followed by a USER turn
    that carries the read-only ``<transcript>`` and asks for the notes. The
    notetaker prompt yields a markdown document (title + overview).

    Custom-template flow (PRD-10, ``config.summary_template`` non-empty): the
    chosen named template drives the prompt instead of the notetaker prompt so a
    user can pick TL;DR / decisions / action-items (or their own) and regenerate
    with a different one. The calendar context is NOT injected here — the template
    is user-owned.

    * If the template contains the :data:`TEMPLATE_PLACEHOLDER` (``{transcript}``)
      it OWNS the framing: the read-only transcript is spliced in at the
      placeholder and the whole thing is the single user turn.
    * Otherwise the template is the user instruction and the standard read-only
      ``<transcript>`` context system message is still prepended.

    Either way the transcript is obtained ONLY through the read-only ``reader``;
    nothing here can write a transcript/meta file.
    """
    template = (config.summary_template or "").strip()
    if not template:
        transcript = reader.read(meeting_id, "live")
        if len(transcript) > CONTEXT_CHAR_BUDGET:
            transcript = transcript[-CONTEXT_CHAR_BUDGET:]
        system_parts = [NOTETAKER_PROMPT]
        # Name the transcript's language EXPLICITLY when we can tell it — a small
        # on-device model follows "Write in Spanish" far more reliably than the
        # generic "match the transcript" rule (which it inconsistently ignored,
        # defaulting to English). Falls back to the generic rule when unsure.
        lang = detect_transcript_language(transcript)
        if lang:
            system_parts.append(
                f"OUTPUT LANGUAGE — NON-NEGOTIABLE: the meeting is in {lang}. Write the "
                f"ENTIRE response — the title, every section header, and every bullet — "
                f"in {lang}. Do not write in English (unless {lang} is English)."
            )
        block = build_calendar_context_block(context)
        if block:
            system_parts.append(block)
        return [
            ChatMessage(role="system", content="\n\n".join(system_parts)),
            ChatMessage(
                role="user",
                content=(
                    "Here is the meeting transcript — your only ground truth "
                    "(read-only):\n\n"
                    f"<transcript>\n{transcript}\n</transcript>\n\n"
                    "Write the meeting notes now."
                ),
            ),
        ]

    if TEMPLATE_PLACEHOLDER in template:
        transcript = reader.read(meeting_id, "live")
        if len(transcript) > CONTEXT_CHAR_BUDGET:
            transcript = transcript[-CONTEXT_CHAR_BUDGET:]
        prompt = template.replace(TEMPLATE_PLACEHOLDER, transcript)
        return [ChatMessage(role="user", content=prompt)]

    # Template without a placeholder: keep the read-only transcript context, use
    # the template as the instruction.
    messages = []
    context = build_context_message(reader, meeting_id)
    if context is not None:
        messages.append(context)
    messages.append(ChatMessage(role="user", content=template))
    return messages


def summarize(
    meeting_id: str,
    provider: ChatProvider,
    config: ProviderConfig,
    *,
    api_key: Optional[str] = None,
    reader: Optional[TranscriptReader] = None,
    on_delta: Optional[Callable[[str], None]] = None,
    context: object = None,
) -> Summary:
    """Generate a structured :class:`Summary` for a meeting via ``provider``.

    Reads the transcript READ-ONLY (``reader`` defaults to the on-disk
    :class:`~loqui_sidecar.providers.transcript.FsTranscriptReader`), builds the
    grounding context exactly like the chat handler, asks the provider to
    summarize, and returns the parsed :class:`Summary`. Raises
    :class:`ChatProviderError` on a provider failure (the runner maps it to a
    ``jobUpdate`` error + a skipped summary stage). NEVER logs ``api_key`` and
    NEVER writes the transcript.

    ``on_delta`` (optional) is called with each text delta as the provider
    streams, so the runner can forward a live ``summaryToken`` to the renderer
    (the streamed summary UX). It never affects the parsed result and a raising
    sink is swallowed so streaming can never break summary generation.

    The provider is asked for a JSON envelope (:data:`SUMMARY_INSTRUCTION`);
    :func:`_parse_summary` maps it onto the structured :class:`Summary` fields
    and degrades to a raw-text TL;DR when the output is not parseable JSON.
    """
    reader = reader or default_transcript_reader()
    messages = build_summary_messages(meeting_id, config, reader, context)

    assembled: list[str] = []
    try:
        for delta in provider.stream_chat(messages, config, api_key):
            if delta:
                assembled.append(delta)
                if on_delta is not None:
                    try:
                        on_delta(delta)
                    except Exception:  # noqa: BLE001 - a streaming sink must never break summary.
                        logger.warning("summary on_delta sink raised", exc_info=True)
    except ChatProviderError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalize to the provider-error code.
        raise ChatProviderError("internal_error", "summary generation failed") from exc

    text = "".join(assembled).strip()
    # Reject an echoed prompt/instruction (e.g. a degraded extractive engine) so it
    # never becomes the "summary" — the runner maps this to a clean summary-stage
    # error + jobUpdate, and the UI shows a clear failure instead of garbage. The
    # hermetic "fake" provider intentionally echoes the context to prove read-only
    # grounding, so it is exempt (it is never a real provider in production).
    if config.provider != "fake" and _looks_like_prompt_echo(text):
        raise ChatProviderError(
            "provider_error",
            "The summary provider returned the prompt instead of a summary "
            "(no generative model available).",
        )
    return _parse_summary(
        text,
        meeting_id=meeting_id,
        provider=config.provider,
        model=getattr(provider, "name", config.provider),
    )
