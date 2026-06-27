"""Dependency-free language naming for prompts.

Small on-device models follow an EXPLICIT "write in Spanish" far more reliably
than a generic "match the input language". We name the language from text using a
whole-word stopword fingerprint for the common meeting languages — reliable for
paragraph-length text, with a clear-winner margin so an ambiguous/short input
returns None (callers then fall back to the generic instruction).

Pure + offline + no third-party deps. Used by both the summary step
(postprocess.summary) and the chat handler (providers.handler), so it lives here
to avoid an import cycle between those two.
"""

from __future__ import annotations

import re
from typing import Optional

#: Whole-word stopword fingerprints per language (lowercased).
_LANGUAGE_STOPWORDS: dict[str, set[str]] = {
    "English": {"the", "and", "of", "to", "in", "that", "is", "for", "with", "on", "are", "was", "this", "it", "you", "we", "have", "but"},
    "Spanish": {"que", "de", "la", "el", "los", "las", "una", "un", "en", "y", "para", "con", "se", "no", "es", "está", "esto", "pero", "como", "por", "acá", "aquí", "muy"},
    "Portuguese": {"que", "de", "o", "a", "os", "as", "uma", "um", "em", "e", "para", "com", "não", "é", "está", "isso", "mas", "como", "por", "você", "aqui", "muito"},
    "French": {"que", "de", "le", "la", "les", "un", "une", "des", "et", "en", "pour", "avec", "ne", "est", "ce", "mais", "comme", "par", "vous", "nous", "pas"},
    "German": {"der", "die", "das", "und", "ist", "ich", "nicht", "ein", "eine", "zu", "den", "mit", "für", "auf", "wir", "sie", "war", "aber"},
    "Italian": {"che", "di", "il", "la", "le", "un", "una", "e", "in", "per", "con", "non", "è", "questo", "ma", "come", "da", "voi", "noi", "molto"},
}

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def detect_language(text: str) -> Optional[str]:
    """Best-effort language NAME (e.g. "Spanish") for ``text``, or None when it
    can't be told confidently (short/ambiguous input). Counts per-language
    stopword hits and requires a clear winner over the runner-up."""
    if not text:
        return None
    words = [w.lower() for w in _WORD_RE.findall(text)]
    if len(words) < 12:
        return None
    counts = {lang: sum(1 for w in words if w in stop) for lang, stop in _LANGUAGE_STOPWORDS.items()}
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    (top_lang, top), (_, second) = ranked[0], ranked[1]
    if top >= 4 and top >= max(2, int(second * 1.3) + 1):
        return top_lang
    return None
