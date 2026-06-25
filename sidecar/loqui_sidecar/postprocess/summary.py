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
from typing import Optional

from ..providers.handler import CONTEXT_CHAR_BUDGET, build_context_message
from ..providers.types import (
    ChatMessage,
    ChatProvider,
    ChatProviderError,
    ProviderConfig,
    TranscriptReader,
)
from ..providers.transcript import default_transcript_reader
from .types import ActionItem, Summary

logger = logging.getLogger("loqui_sidecar.postprocess.summary")

#: The instruction prepended to the read-only transcript context so the provider
#: returns a structured summary. We ask for a parseable JSON envelope so the
#: streamed output maps cleanly onto the :class:`Summary` fields; if the provider
#: returns prose instead, :func:`_parse_summary` degrades to putting the raw text
#: in the TL;DR (still non-empty + searchable).
SUMMARY_INSTRUCTION = (
    "Summarize the meeting from the transcript above. Use ONLY the transcript "
    "as ground truth. Respond with a SINGLE JSON object (no prose, no code "
    "fences) with exactly these keys:\n"
    '  "tldr": a short paragraph summarizing the meeting,\n'
    '  "decisions": an array of strings, each a key decision made,\n'
    '  "action_items": an array of objects {"text": string, "owner": '
    "string|null} (owner only when a person is clearly named),\n"
    '  "topics": an array of strings, each a topic discussed.\n'
    "Use empty arrays when a section has no content."
)

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


def _parse_summary(text: str, meeting_id: str, provider: str, model: str) -> Summary:
    """Map the provider's streamed output onto a structured :class:`Summary`.

    Prefers the JSON envelope requested by :data:`SUMMARY_INSTRUCTION`; on any
    parse failure (e.g. the fake provider or a non-compliant model) it degrades
    to the raw text as the TL;DR so the summary stays non-empty + searchable.
    """
    base = dict(meeting_id=meeting_id, provider=provider, model=model)
    parsed = _extract_json_object(text)
    if parsed is None:
        return Summary(tldr=text, **base)

    tldr = str(parsed.get("tldr", "")).strip()
    decisions = _coerce_str_list(parsed.get("decisions"))
    action_items = _coerce_action_items(parsed.get("action_items"))
    topics = _coerce_str_list(parsed.get("topics"))
    # Nothing usable parsed out -> fall back to the raw text TL;DR.
    if not tldr and not (decisions or action_items or topics):
        return Summary(tldr=text, **base)
    # Structure but an empty TL;DR -> seed the TL;DR so the index stays non-empty.
    if not tldr:
        tldr = text.strip()
    return Summary(
        tldr=tldr,
        decisions=decisions,
        action_items=action_items,
        topics=topics,
        **base,
    )


def build_summary_messages(
    meeting_id: str,
    config: ProviderConfig,
    reader: TranscriptReader,
) -> list[ChatMessage]:
    """Build the provider ``messages`` for a summary request (READ-ONLY).

    Default flow (no custom template): prepend the handler-built ``<transcript>``
    context system message + the built-in :data:`SUMMARY_INSTRUCTION` as the user
    turn — byte-identical to the pre-PRD-10 behavior.

    Custom-template flow (PRD-10, ``config.summary_template`` non-empty): the
    chosen named template drives the prompt instead of the default instruction so
    a user can pick TL;DR / decisions / action-items (or their own) and regenerate
    with a different one.

    * If the template contains the :data:`TEMPLATE_PLACEHOLDER` (``{transcript}``)
      it OWNS the framing: the read-only transcript is spliced in at the
      placeholder and the whole thing is the single user turn (no separate context
      message — the template already carries the transcript).
    * Otherwise the template is the user instruction and the standard read-only
      ``<transcript>`` context system message is still prepended, so a template
      that just says "Give me action items" still sees the transcript.

    Either way the transcript is obtained ONLY through the read-only ``reader``;
    nothing here can write a transcript/meta file.
    """
    template = (config.summary_template or "").strip()
    if not template:
        messages: list[ChatMessage] = []
        context = build_context_message(reader, meeting_id)
        if context is not None:
            messages.append(context)
        messages.append(ChatMessage(role="user", content=SUMMARY_INSTRUCTION))
        return messages

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
) -> Summary:
    """Generate a structured :class:`Summary` for a meeting via ``provider``.

    Reads the transcript READ-ONLY (``reader`` defaults to the on-disk
    :class:`~loqui_sidecar.providers.transcript.FsTranscriptReader`), builds the
    grounding context exactly like the chat handler, asks the provider to
    summarize, and returns the parsed :class:`Summary`. Raises
    :class:`ChatProviderError` on a provider failure (the runner maps it to a
    ``jobUpdate`` error + a skipped summary stage). NEVER logs ``api_key`` and
    NEVER writes the transcript.

    The provider is asked for a JSON envelope (:data:`SUMMARY_INSTRUCTION`);
    :func:`_parse_summary` maps it onto the structured :class:`Summary` fields
    and degrades to a raw-text TL;DR when the output is not parseable JSON.
    """
    reader = reader or default_transcript_reader()
    messages = build_summary_messages(meeting_id, config, reader)

    assembled: list[str] = []
    try:
        for delta in provider.stream_chat(messages, config, api_key):
            if delta:
                assembled.append(delta)
    except ChatProviderError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalize to the provider-error code.
        raise ChatProviderError("internal_error", "summary generation failed") from exc

    text = "".join(assembled).strip()
    return _parse_summary(
        text,
        meeting_id=meeting_id,
        provider=config.provider,
        model=getattr(provider, "name", config.provider),
    )
