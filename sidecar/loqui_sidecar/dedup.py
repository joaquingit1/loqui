"""Speaker-bleed de-duplication (PURE) — the shared text/time heuristic that
suppresses mic segments that are really the SYSTEM (remote) speaker bled into the
microphone.

Loqui records two streams per meeting: mic ("You", ``source:"mic"``) and macOS
system audio ("They", ``source:"system"`` via ScreenCaptureKit). When the user
plays the meeting audio on SPEAKERS, the mic ALSO picks up the computer audio, so
the same remote-speaker utterance is transcribed TWICE: once on system (correct,
"They") and once on mic (bleed, wrongly attributed to "You"). Bleed is one-way —
system leaks into mic, never the reverse — so we only ever suppress MIC segments,
never system ones.

This is a PURE module (no I/O, no model, no deps beyond difflib) so both the LIVE
suppression seam (``transcription/manager.py``) and the AUTHORITATIVE post-process
cleanup (``postprocess/runner.py``) share ONE heuristic and ONE test surface.

The core call is :func:`is_bleed_duplicate`: a mic segment is a bleed duplicate of
a system segment when they TEMPORALLY OVERLAP (within a small slack window that
absorbs decode jitter + the ~tens-of-ms acoustic delay) AND the normalized texts
are near-identical — OR the (shorter) mic text is an almost-contained substring of
the overlapping system text (a partial bleed pickup where the mic only caught part
of the remote utterance). Genuine short backchannels ("ok" / "yeah" / "sí") are
GUARDED against: a mic segment below a minimum normalized length is never
suppressed, so both parties saying "ok" is preserved.

Thresholds are module constants, each env-overridable (the codebase's env-knob
pattern) so they can be tuned in the field without a rebuild.
"""

from __future__ import annotations

import os
import re
from difflib import SequenceMatcher

#: Minimum normalized-text similarity (difflib ratio over normalized tokens, 0..1)
#: for two overlapping segments to count as the same utterance. High enough that a
#: genuine paraphrase ("ship it Friday" vs "let's ship on Friday") stays BELOW it,
#: low enough to absorb the small word errors two decodes of the same audio make.
DEFAULT_SIMILARITY = 0.85
SIMILARITY_ENV = "LOQUI_BLEED_SIMILARITY"

#: Temporal slack (seconds) added on BOTH sides when testing overlap. The mic and
#: system finals decode independently so their timestamps jitter by a few hundred
#: ms; ~1.75 s of slack absorbs that jitter + the acoustic bleed delay without
#: matching utterances that are genuinely far apart in the meeting.
DEFAULT_WINDOW_SEC = 1.75
WINDOW_ENV = "LOQUI_BLEED_WINDOW_SEC"

#: Backchannel guard: a mic segment whose NORMALIZED text is shorter than this many
#: chars is never suppressed (both parties may genuinely say "ok"/"yeah"/"sí").
DEFAULT_MIN_CHARS = 12
MIN_CHARS_ENV = "LOQUI_BLEED_MIN_CHARS"

#: Backchannel guard (tokens): a mic segment with fewer than this many normalized
#: tokens is never suppressed. Both the char AND the token floor must be cleared.
DEFAULT_MIN_TOKENS = 3
MIN_TOKENS_ENV = "LOQUI_BLEED_MIN_TOKENS"

#: Substring-bleed threshold: when the mic text is (almost) a contained substring of
#: the overlapping system text, the fraction of mic tokens that appear as a
#: contiguous run inside the system tokens must reach this to count as a partial
#: bleed pickup. Slightly below the full-match similarity since a partial pickup is
#: by definition incomplete.
DEFAULT_CONTAINMENT = 0.9
CONTAINMENT_ENV = "LOQUI_BLEED_CONTAINMENT"


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Strip everything that is not a letter/number/whitespace (any script, so Spanish
# accents + CJK survive) — punctuation differences between two decodes of the same
# audio must not lower the similarity.
_PUNCT_RE = re.compile(r"[^\w\s]", flags=re.UNICODE)
_WS_RE = re.compile(r"\s+", flags=re.UNICODE)


def normalize_text(text: str) -> str:
    """Casefold, drop punctuation, collapse whitespace — the comparison form.

    Deterministic + pure. Two decodes of the same audio that differ only in
    capitalization / punctuation / spacing normalize to the SAME string.
    """
    folded = _PUNCT_RE.sub(" ", text.casefold())
    return _WS_RE.sub(" ", folded).strip()


def normalize_tokens(text: str) -> list[str]:
    """Normalized whitespace-split tokens (the similarity + containment unit)."""
    norm = normalize_text(text)
    return norm.split() if norm else []


def text_similarity(a: str, b: str) -> float:
    """Token-level similarity of two texts (difflib ratio over normalized tokens).

    Token-level (not char-level) so a one-word substitution costs a whole token,
    not a few characters — a genuine paraphrase scores lower than a same-audio
    re-decode. Symmetric; 1.0 for identical normalized token sequences, 0.0 for
    disjoint ones.
    """
    ta = normalize_tokens(a)
    tb = normalize_tokens(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return SequenceMatcher(a=ta, b=tb, autojunk=False).ratio()


def _containment(short_tokens: list[str], long_tokens: list[str]) -> float:
    """Fraction of ``short_tokens`` covered by the longest contiguous run also
    present, in order, inside ``long_tokens`` (0..1). Used to detect a partial
    bleed pickup where the mic only caught PART of the remote utterance."""
    if not short_tokens:
        return 0.0
    match = SequenceMatcher(a=short_tokens, b=long_tokens, autojunk=False).find_longest_match(
        0, len(short_tokens), 0, len(long_tokens)
    )
    return match.size / len(short_tokens)


def _overlaps(
    a_start: float,
    a_end: float,
    b_start: float,
    b_end: float,
    window: float,
) -> bool:
    """True when ``[a_start, a_end]`` overlaps ``[b_start, b_end]`` after each is
    padded by ``window`` seconds on both sides (absorbs decode jitter)."""
    return (a_start - window) <= (b_end + window) and (b_start - window) <= (a_end + window)


def is_bleed_duplicate(
    mic_text: str,
    mic_t_start: float,
    mic_t_end: float,
    system_text: str,
    system_t_start: float,
    system_t_end: float,
    *,
    similarity: float | None = None,
    window: float | None = None,
    min_chars: int | None = None,
    min_tokens: int | None = None,
    containment: float | None = None,
) -> bool:
    """True when the MIC segment is system-audio bleed of the SYSTEM segment.

    A mic segment is bleed when it (a) TEMPORALLY OVERLAPS the system segment
    within ``window`` seconds of slack AND (b) is textually the same utterance:
    either near-identical normalized text (similarity >= ``similarity``) OR the mic
    text is an almost-contained substring of the (longer) system text
    (containment >= ``containment``) — a partial pickup.

    GUARD: a mic segment whose normalized text is shorter than ``min_chars`` chars
    OR ``min_tokens`` tokens is NEVER suppressed, so genuine short backchannels
    ("ok"/"yeah"/"sí") both parties may say are preserved.

    Thresholds default to the module constants (env-overridable); callers pass
    explicit values only to override per-call (e.g. tests).
    """
    similarity = DEFAULT_SIMILARITY if similarity is None else similarity
    window = DEFAULT_WINDOW_SEC if window is None else window
    min_chars = DEFAULT_MIN_CHARS if min_chars is None else min_chars
    min_tokens = DEFAULT_MIN_TOKENS if min_tokens is None else min_tokens
    containment = DEFAULT_CONTAINMENT if containment is None else containment

    mic_tokens = normalize_tokens(mic_text)
    mic_norm = " ".join(mic_tokens)
    # Backchannel guard: never suppress a too-short mic utterance.
    if len(mic_norm) < min_chars or len(mic_tokens) < min_tokens:
        return False

    if not _overlaps(mic_t_start, mic_t_end, system_t_start, system_t_end, window):
        return False

    sys_tokens = normalize_tokens(system_text)
    if not sys_tokens:
        return False

    if text_similarity(mic_text, system_text) >= similarity:
        return True

    # Partial bleed: the mic caught only PART of the remote utterance, so the mic
    # text is (almost) a contiguous substring of the longer system text. Only tested
    # when the system side is the longer of the two (bleed is system -> mic).
    if len(sys_tokens) > len(mic_tokens) and _containment(mic_tokens, sys_tokens) >= containment:
        return True

    return False


def resolved_thresholds() -> dict[str, float]:
    """The effective thresholds after env overrides — for logging / diagnostics.

    Reads the env each call (cheap) so a knob set for one run is reflected without
    a reload; callers that want a snapshot cache the return value themselves.
    """
    return {
        "similarity": _env_float(SIMILARITY_ENV, DEFAULT_SIMILARITY),
        "window": _env_float(WINDOW_ENV, DEFAULT_WINDOW_SEC),
        "min_chars": float(_env_int(MIN_CHARS_ENV, DEFAULT_MIN_CHARS)),
        "min_tokens": float(_env_int(MIN_TOKENS_ENV, DEFAULT_MIN_TOKENS)),
        "containment": _env_float(CONTAINMENT_ENV, DEFAULT_CONTAINMENT),
    }


def is_bleed_duplicate_env(
    mic_text: str,
    mic_t_start: float,
    mic_t_end: float,
    system_text: str,
    system_t_start: float,
    system_t_end: float,
) -> bool:
    """:func:`is_bleed_duplicate` with thresholds taken from the env knobs.

    The seam the live suppression + post cleanup call, so a single set of
    ``LOQUI_BLEED_*`` env overrides tunes BOTH paths identically.
    """
    t = resolved_thresholds()
    return is_bleed_duplicate(
        mic_text,
        mic_t_start,
        mic_t_end,
        system_text,
        system_t_start,
        system_t_end,
        similarity=t["similarity"],
        window=t["window"],
        min_chars=int(t["min_chars"]),
        min_tokens=int(t["min_tokens"]),
        containment=t["containment"],
    )
