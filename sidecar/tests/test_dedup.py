"""Unit tests for the speaker-bleed de-duplication heuristic (``loqui_sidecar.dedup``).

PURE + hermetic: no I/O, no model, no env unless a test sets it explicitly. Covers
the correctness surface the live suppression + the post cleanup both depend on:
exact dupes, paraphrases BELOW the threshold (not suppressed), short backchannels
(not suppressed), partial substring bleed, the overlap-window edges, and the env
overrides.
"""

from __future__ import annotations

from loqui_sidecar.dedup import (
    CONTAINMENT_ENV,
    MIN_CHARS_ENV,
    SIMILARITY_ENV,
    WINDOW_ENV,
    is_bleed_duplicate,
    is_bleed_duplicate_env,
    normalize_text,
    normalize_tokens,
    resolved_thresholds,
    text_similarity,
)

# --- normalization ------------------------------------------------------------


def test_normalize_casefolds_strips_punct_collapses_ws():
    assert normalize_text("  Hello,   THERE!!  ") == "hello there"
    # Punctuation (incl. apostrophes) is replaced by a space, so it never lowers
    # similarity between two decodes that punctuate the same audio differently.
    assert normalize_text("It's a test.") == "it s a test"


def test_normalize_preserves_accents_and_non_ascii():
    # Spanish accents + non-latin survive (\w is unicode-aware) — bleed happens in
    # any language.
    assert normalize_text("¿Sí, señor?") == "sí señor"
    assert normalize_tokens("café  con leche") == ["café", "con", "leche"]


def test_similarity_identical_and_disjoint():
    assert text_similarity("ship it friday", "SHIP IT, FRIDAY!") == 1.0
    assert text_similarity("apple banana cherry", "xy zz qq") == 0.0
    assert text_similarity("", "") == 1.0
    assert text_similarity("hello", "") == 0.0


# --- is_bleed_duplicate: positive cases ---------------------------------------


def test_exact_duplicate_overlapping_is_bleed():
    # Same utterance, same window: the classic bleed twin.
    assert is_bleed_duplicate(
        "Let's ship the release on Friday afternoon",
        10.0,
        13.0,
        "Let's ship the release on Friday afternoon.",
        10.1,
        13.2,
    )


def test_near_identical_with_minor_word_error_is_bleed():
    # Two decodes of the same audio differ by one word — still above threshold.
    assert is_bleed_duplicate(
        "we should schedule the review for next Tuesday morning",
        5.0,
        9.0,
        "we should schedule the review for the next Tuesday morning",
        5.0,
        9.0,
    )


def test_partial_substring_pickup_is_bleed():
    # The mic caught only PART of the longer remote utterance (partial bleed).
    mic = "migrate the database next week"
    system = "okay so the plan is to migrate the database next week and then test"
    assert is_bleed_duplicate(mic, 20.0, 23.0, system, 19.5, 26.0)


# --- is_bleed_duplicate: negative cases (guards) ------------------------------


def test_short_backchannel_not_suppressed_even_if_identical():
    # Both parties genuinely say "ok" / "yeah" — never suppress (char + token floor).
    assert not is_bleed_duplicate("ok", 1.0, 1.3, "ok", 1.0, 1.3)
    assert not is_bleed_duplicate("yeah sure", 1.0, 1.5, "yeah sure", 1.0, 1.5)
    assert not is_bleed_duplicate("sí claro", 1.0, 1.5, "sí claro", 1.0, 1.5)


def test_paraphrase_below_threshold_not_suppressed():
    # Same MEANING, different words: a genuine both-said exchange, not bleed.
    mic = "I think we should probably wait until the next sprint honestly"
    system = "let us hold off and revisit this during the following iteration"
    assert not is_bleed_duplicate(mic, 4.0, 8.0, system, 4.0, 8.0)


def test_no_temporal_overlap_not_suppressed():
    # Same text but far apart in time: two separate genuine utterances.
    text = "let's ship the release on Friday afternoon"
    assert not is_bleed_duplicate(text, 0.0, 3.0, text, 100.0, 103.0)


def test_containment_does_not_fire_when_mic_is_longer():
    # Bleed is system -> mic, so the mic (bleed) side is never LONGER than system.
    # A long mic segment merely CONTAINING a short system phrase is not bleed.
    mic = "the short phrase here plus a lot of extra unique mic content that differs"
    system = "the short phrase here"
    assert not is_bleed_duplicate(mic, 0.0, 5.0, system, 0.0, 2.0)


# --- overlap-window edges -----------------------------------------------------


def test_overlap_window_edge_within_and_beyond_slack():
    text = "we need to finalize the quarterly budget numbers today"
    # Gap of 1.5s between mic end and system start: within the ~1.75s default slack.
    assert is_bleed_duplicate(text, 0.0, 3.0, text, 4.5, 7.5)
    # Gap of 5s: well beyond the slack, so no overlap -> not bleed.
    assert not is_bleed_duplicate(text, 0.0, 3.0, text, 8.0, 11.0)


def test_explicit_window_override_widens_overlap():
    text = "we need to finalize the quarterly budget numbers today"
    # 5s gap is NOT bleed by default, but IS with a wide explicit window.
    assert not is_bleed_duplicate(text, 0.0, 3.0, text, 8.0, 11.0)
    assert is_bleed_duplicate(text, 0.0, 3.0, text, 8.0, 11.0, window=3.0)


def test_explicit_similarity_override_changes_verdict():
    mic = "the migration plan needs another review before we ship"
    system = "the migration plan really needs one more careful review before we ship it"
    # Below the strict default; a looser explicit threshold flips it to bleed.
    assert not is_bleed_duplicate(mic, 0.0, 4.0, system, 0.0, 4.0, similarity=0.99)
    assert is_bleed_duplicate(mic, 0.0, 4.0, system, 0.0, 4.0, similarity=0.5)


# --- env overrides ------------------------------------------------------------


def test_env_similarity_override(monkeypatch):
    mic = "the migration plan needs another review before we ship"
    system = "the migration plan really needs one more careful review before we ship it"
    assert not is_bleed_duplicate_env(mic, 0.0, 4.0, system, 0.0, 4.0)
    monkeypatch.setenv(SIMILARITY_ENV, "0.4")
    assert is_bleed_duplicate_env(mic, 0.0, 4.0, system, 0.0, 4.0)


def test_env_window_override(monkeypatch):
    text = "we need to finalize the quarterly budget numbers today"
    assert not is_bleed_duplicate_env(text, 0.0, 3.0, text, 8.0, 11.0)
    monkeypatch.setenv(WINDOW_ENV, "3.0")
    assert is_bleed_duplicate_env(text, 0.0, 3.0, text, 8.0, 11.0)


def test_env_min_chars_override_can_relax_backchannel_guard(monkeypatch):
    # A short-but-identical overlapping pair is guarded by default; lowering the
    # char floor (and token floor) exposes it as bleed.
    assert not is_bleed_duplicate_env("go now", 1.0, 1.4, "go now", 1.0, 1.4)
    monkeypatch.setenv(MIN_CHARS_ENV, "1")
    monkeypatch.setenv("LOQUI_BLEED_MIN_TOKENS", "1")
    assert is_bleed_duplicate_env("go now", 1.0, 1.4, "go now", 1.0, 1.4)


def test_env_containment_override(monkeypatch):
    mic = "migrate the database"
    system = "so first we migrate the database and then we run the tests carefully"
    monkeypatch.setenv(CONTAINMENT_ENV, "0.99")
    # Full contiguous run present -> still bleed even at a strict containment.
    assert is_bleed_duplicate_env(mic, 5.0, 7.0, system, 4.0, 12.0)


def test_resolved_thresholds_reads_env(monkeypatch):
    monkeypatch.setenv(SIMILARITY_ENV, "0.7")
    monkeypatch.setenv(WINDOW_ENV, "2.5")
    monkeypatch.setenv(MIN_CHARS_ENV, "20")
    t = resolved_thresholds()
    assert t["similarity"] == 0.7
    assert t["window"] == 2.5
    assert t["min_chars"] == 20.0


def test_resolved_thresholds_ignores_garbage_env(monkeypatch):
    monkeypatch.setenv(SIMILARITY_ENV, "not-a-number")
    t = resolved_thresholds()
    assert t["similarity"] == 0.85  # falls back to the default
