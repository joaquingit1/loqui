"""Exhaustive hermetic unit tests for the LocalAgreement-2 streaming policy.

PURE + deterministic: no model, no audio, no I/O — every test drives the policy
with hand-scripted hypotheses (lists of timed tokens) and asserts the committed
(final) / partial split, monotonicity, and the no-duplicate / no-overlap
guarantees (PRD-2 acceptance #5).

The policy contract (loqui_sidecar.transcription.types.StreamingPolicy):

    update(tokens: list[AsrToken]) -> PolicyResult(committed, partial, committed_seconds)
    flush() -> PolicyResult            # force-commit the remaining tail
    reset() -> None                    # wipe per-utterance state
"""

from __future__ import annotations

import pytest

from loqui_sidecar.transcription import (
    AsrToken,
    LocalAgreementPolicy,
    PolicyResult,
    StreamingPolicy,
)
from loqui_sidecar.transcription.streaming import normalize_token_text

# --- helpers -----------------------------------------------------------------


def hyp(*words: str, start: float = 0.0, step: float = 0.5) -> list[AsrToken]:
    """Build a hypothesis: one AsrToken per word, contiguous timestamps.

    Token i spans [start + i*step, start + (i+1)*step). Lets tests express a
    growing window as a list of words and reason about committed_seconds.
    """
    out: list[AsrToken] = []
    for i, w in enumerate(words):
        t0 = start + i * step
        out.append(AsrToken(text=w, t_start=t0, t_end=t0 + step))
    return out


def texts(tokens: list[AsrToken]) -> list[str]:
    return [t.text for t in tokens]


def words_of(result_tokens: list[AsrToken]) -> str:
    return " ".join(t.text for t in result_tokens)


# --- protocol & basic shape --------------------------------------------------


def test_policy_satisfies_streaming_protocol():
    assert isinstance(LocalAgreementPolicy(), StreamingPolicy)


def test_empty_update_returns_empty_result():
    p = LocalAgreementPolicy()
    r = p.update([])
    assert isinstance(r, PolicyResult)
    assert r.committed == []
    assert r.partial == []
    assert r.committed_seconds == 0.0


def test_first_update_never_commits_only_partial():
    # LocalAgreement-2 needs TWO decodes to agree; a single decode can only be
    # interim (partial), never final.
    p = LocalAgreementPolicy()
    r = p.update(hyp("hello", "world"))
    assert r.committed == []
    assert texts(r.partial) == ["hello", "world"]
    assert r.committed_seconds == 0.0


# --- core agreement: two consecutive hypotheses confirm a prefix -------------


def test_two_agreeing_hypotheses_commit_the_agreed_prefix():
    p = LocalAgreementPolicy()
    p.update(hyp("the", "quick", "brown"))
    # Second decode agrees on "the quick", but the 3rd word changed -> only the
    # agreed prefix "the quick" is committed; "fox" is still interim.
    r = p.update(hyp("the", "quick", "fox"))
    assert texts(r.committed) == ["the", "quick"]
    assert texts(r.partial) == ["fox"]
    # committed_seconds == t_end of the last committed token ("quick": 0.5..1.0).
    assert r.committed_seconds == 1.0


def test_full_agreement_commits_everything_new():
    p = LocalAgreementPolicy()
    p.update(hyp("alpha", "beta"))
    r = p.update(hyp("alpha", "beta"))
    assert texts(r.committed) == ["alpha", "beta"]
    assert r.partial == []
    assert r.committed_seconds == 1.0


def test_disagreement_holds_everything_back():
    # No common prefix between the two decodes -> nothing is stable yet.
    p = LocalAgreementPolicy()
    p.update(hyp("foo", "bar"))
    r = p.update(hyp("baz", "qux"))
    assert r.committed == []
    assert texts(r.partial) == ["baz", "qux"]
    assert r.committed_seconds == 0.0


def test_partial_then_agreement_confirms():
    # First decode is interim; the next decode repeats it verbatim -> confirmed.
    p = LocalAgreementPolicy()
    r1 = p.update(hyp("hello"))
    assert r1.committed == [] and texts(r1.partial) == ["hello"]
    r2 = p.update(hyp("hello"))
    assert texts(r2.committed) == ["hello"]
    assert r2.partial == []


# --- monotonic growth: finals extend, never retract --------------------------


def test_growing_agreement_extends_finals_monotonically():
    p = LocalAgreementPolicy()
    committed_words: list[str] = []
    last_seconds = 0.0

    # A window that grows one stable word at a time; each new decode confirms the
    # previous decode's tail and adds a fresh interim word.
    sequence = [
        hyp("a"),
        hyp("a", "b"),
        hyp("a", "b", "c"),
        hyp("a", "b", "c", "d"),
    ]
    for h in sequence:
        r = p.update(h)
        committed_words.extend(texts(r.committed))
        # committed_seconds is non-decreasing across the whole utterance.
        assert r.committed_seconds >= last_seconds
        last_seconds = r.committed_seconds

    # Each word, once it appeared in two consecutive decodes, was committed once.
    # "d" only appeared in the last decode -> still interim.
    assert committed_words == ["a", "b", "c"]
    assert p.committed_seconds == last_seconds


def test_committed_never_retracted_when_tail_changes():
    p = LocalAgreementPolicy()
    p.update(hyp("one", "two", "three"))
    r1 = p.update(hyp("one", "two", "tree"))  # tail disagreed (three -> tree)
    assert texts(r1.committed) == ["one", "two"]
    # The interim 3rd word is unsettled ("tree"); a fresh decode that flips it
    # back to "three" still does NOT agree with the prior interim, so nothing new
    # commits — LocalAgreement-2 needs two CONSECUTIVE agreeing decodes.
    r2 = p.update(hyp("one", "two", "three", "four"))
    assert r2.committed == []  # "three" disagreed with prior interim "tree"
    assert texts(r2.partial) == ["three", "four"]
    # Now repeat the same tail: "three four" agrees with itself -> both commit.
    r3 = p.update(hyp("one", "two", "three", "four"))
    assert texts(r3.committed) == ["three", "four"]
    # Full committed history grew monotonically, no dup / retraction of one/two.
    assert texts(p.committed) == ["one", "two", "three", "four"]


def test_a_token_is_committed_at_most_once_across_many_repeats():
    p = LocalAgreementPolicy()
    # Repeat the SAME full hypothesis many times: it should commit exactly once.
    h = hyp("repeat", "me", "please")
    p.update(h)  # first decode: all interim
    r = p.update(h)  # second decode: all three confirmed at once
    assert texts(r.committed) == ["repeat", "me", "please"]
    for _ in range(5):
        again = p.update(h)
        assert again.committed == []  # nothing new — never a duplicate
        assert again.partial == []
    assert texts(p.committed) == ["repeat", "me", "please"]


# --- committed / partial never overlap ---------------------------------------


def test_committed_and_partial_do_not_overlap_in_one_result():
    p = LocalAgreementPolicy()
    p.update(hyp("x", "y", "z"))
    r = p.update(hyp("x", "y", "w"))
    committed_texts = set(texts(r.committed))
    partial_texts = set(texts(r.partial))
    assert committed_texts == {"x", "y"}
    assert partial_texts == {"w"}
    assert committed_texts.isdisjoint(partial_texts)


# --- punctuation / whitespace / case normalization ---------------------------


def test_normalize_token_text_helper():
    assert normalize_token_text("Fox.") == "fox"
    assert normalize_token_text("  Hello,  ") == "hello"
    assert normalize_token_text("WORLD!?") == "world"
    assert normalize_token_text("...") == ""  # pure punctuation collapses to empty
    assert normalize_token_text("a b") == "a b"  # internal space preserved+collapsed


def test_agreement_ignores_trailing_punctuation_and_case():
    # The two decodes differ only by case + trailing punctuation; they should
    # still agree and commit. The EMITTED token keeps its original surface form.
    p = LocalAgreementPolicy()
    p.update([AsrToken("Quick", 0.0, 0.5), AsrToken("brown", 0.5, 1.0)])
    r = p.update([AsrToken("quick,", 0.0, 0.5), AsrToken("Brown.", 0.5, 1.0)])
    assert texts(r.committed) == ["quick,", "Brown."]  # original surface forms kept
    assert r.partial == []


def test_pure_punctuation_token_never_commits_on_agreement():
    # A token whose normalized text is empty (just punctuation) can't be the
    # basis of an agreement commit, even repeated.
    p = LocalAgreementPolicy()
    p.update([AsrToken(".", 0.0, 0.2), AsrToken("word", 0.2, 0.7)])
    r = p.update([AsrToken(".", 0.0, 0.2), AsrToken("word", 0.2, 0.7)])
    # Agreement stops at the empty-normalized first token -> nothing committed.
    assert r.committed == []
    assert texts(r.partial) == [".", "word"]


# --- empty / again-empty hypotheses ------------------------------------------


def test_empty_hypotheses_in_a_row_commit_nothing():
    p = LocalAgreementPolicy()
    for _ in range(3):
        r = p.update([])
        assert r.committed == []
        assert r.partial == []
        assert r.committed_seconds == 0.0


def test_speech_then_silence_then_speech_partial_lifecycle():
    p = LocalAgreementPolicy()
    p.update(hyp("hi"))
    r_silent = p.update([])  # decode went silent: no agreement, nothing partial
    assert r_silent.committed == []
    assert r_silent.partial == []
    # A later non-empty decode is interim again (prev was empty -> no agreement).
    r = p.update(hyp("hi"))
    assert r.committed == []
    assert texts(r.partial) == ["hi"]


def test_empty_after_committed_keeps_committed_seconds_stable():
    p = LocalAgreementPolicy()
    p.update(hyp("done"))
    p.update(hyp("done"))  # commits "done"
    assert p.committed_seconds == 0.5
    r = p.update([])  # nothing new; watermark must not move backward
    assert r.committed == []
    assert r.committed_seconds == 0.5


# --- flush -------------------------------------------------------------------


def test_flush_force_commits_the_remaining_interim_tail():
    p = LocalAgreementPolicy()
    p.update(hyp("the", "end"))  # interim only (one decode)
    r = p.flush()
    assert texts(r.committed) == ["the", "end"]
    assert r.partial == []
    assert r.committed_seconds == 1.0


def test_flush_only_commits_the_uncommitted_remainder():
    p = LocalAgreementPolicy()
    p.update(hyp("a", "b", "c"))
    p.update(hyp("a", "b", "x"))  # commits "a b", "x" still interim
    r = p.flush()
    assert texts(r.committed) == ["x"]  # only the uncommitted tail
    assert texts(p.committed) == ["a", "b", "x"]


def test_flush_is_idempotent():
    p = LocalAgreementPolicy()
    p.update(hyp("hi"))
    p.flush()
    r = p.flush()  # nothing left
    assert r.committed == []
    assert r.partial == []


def test_flush_with_no_updates_is_safe():
    p = LocalAgreementPolicy()
    r = p.flush()
    assert r.committed == []
    assert r.partial == []
    assert r.committed_seconds == 0.0


# --- reset / window reset ----------------------------------------------------


def test_reset_clears_all_state_for_a_new_utterance():
    p = LocalAgreementPolicy()
    p.update(hyp("first", "utterance"))
    p.update(hyp("first", "utterance"))
    assert texts(p.committed) == ["first", "utterance"]
    assert p.committed_seconds == 1.0

    p.reset()
    assert p.committed == []
    assert p.committed_seconds == 0.0
    # After reset, the same words are interim again (no carried agreement).
    r1 = p.update(hyp("second", "utterance"))
    assert r1.committed == []
    assert texts(r1.partial) == ["second", "utterance"]
    r2 = p.update(hyp("second", "utterance"))
    assert texts(r2.committed) == ["second", "utterance"]


def test_reset_lets_committed_seconds_restart_from_zero():
    # committed_seconds is non-decreasing WITHIN an utterance, but reset starts a
    # fresh utterance/window whose timeline begins at 0 again.
    p = LocalAgreementPolicy()
    p.update(hyp("late", start=10.0))
    p.update(hyp("late", start=10.0))
    assert p.committed_seconds == pytest.approx(10.5)
    p.reset()
    assert p.committed_seconds == 0.0
    p.update(hyp("early", start=0.0))
    r = p.update(hyp("early", start=0.0))
    assert r.committed_seconds == pytest.approx(0.5)


def test_committed_seconds_does_not_move_backward_on_jittered_tend():
    # A later commit whose last token reports an EARLIER t_end than the existing
    # watermark (decode-window jitter) must NOT drag committed_seconds backward.
    p = LocalAgreementPolicy()
    # Commit a first word ending at t=1.0 -> watermark 1.0.
    p.update([AsrToken("aaa", 0.0, 1.0)])
    r1 = p.update([AsrToken("aaa", 0.0, 1.0)])
    assert texts(r1.committed) == ["aaa"]
    assert r1.committed_seconds == 1.0
    # Now a second word whose jittered t_end (0.9) is BEFORE the watermark.
    p.update([AsrToken("aaa", 0.0, 1.0), AsrToken("bbb", 1.0, 0.9)])
    r2 = p.update([AsrToken("aaa", 0.0, 1.0), AsrToken("bbb", 1.0, 0.9)])
    assert texts(r2.committed) == ["bbb"]
    assert r2.committed_seconds == 1.0  # max(1.0, 0.9) — never regressed


# --- the window re-contains the committed prefix (realistic streaming) -------


def test_window_redecodes_committed_prefix_without_reemitting():
    # Realistic LocalAgreement streaming: the ASR window still holds the audio of
    # already-final words, so each decode RE-CONTAINS the committed prefix. The
    # policy must strip it and only reason about new tokens — never re-commit.
    p = LocalAgreementPolicy()
    p.update(hyp("i", "went"))  # interim
    r2 = p.update(hyp("i", "went", "to"))  # commits "i went"; "to" interim
    assert texts(r2.committed) == ["i", "went"]
    assert texts(r2.partial) == ["to"]
    # Next window still re-decodes "i went to" + adds "the".
    r3 = p.update(hyp("i", "went", "to", "the"))
    assert texts(r3.committed) == ["to"]  # only the newly-agreed token
    assert texts(r3.partial) == ["the"]
    assert texts(p.committed) == ["i", "went", "to"]  # no dup of i/went


# --- a long scripted conversation: full final stream, no dup/overlap ---------


def _flatten_committed(results: list[PolicyResult]) -> list[AsrToken]:
    out: list[AsrToken] = []
    for r in results:
        out.extend(r.committed)
    return out


def test_long_scripted_conversation_produces_expected_final_stream():
    """A multi-utterance scripted stream. Asserts:

    * the concatenated committed (final) text equals the intended transcript;
    * NO token text+span is committed twice (no duplicate finals);
    * committed spans never overlap (no overlapping finals);
    * committed_seconds is non-decreasing within each utterance and resets per
      utterance.
    """
    p = LocalAgreementPolicy()
    all_committed: list[AsrToken] = []
    per_utterance_seconds: list[list[float]] = []

    # --- Utterance 1: a growing window, words stabilize one decode behind. ----
    u1 = [
        hyp("hey"),
        hyp("hey", "can"),
        hyp("hey", "can", "you"),
        hyp("hey", "can", "you", "hear"),
        hyp("hey", "can", "you", "hear", "me"),
    ]
    seconds_seen: list[float] = []
    for h in u1:
        r = p.update(h)
        all_committed.extend(r.committed)
        seconds_seen.append(r.committed_seconds)
    # Endpoint: flush the last interim word ("me").
    rf = p.flush()
    all_committed.extend(rf.committed)
    seconds_seen.append(rf.committed_seconds)
    per_utterance_seconds.append(seconds_seen)
    p.reset()

    # --- Utterance 2: a mid-stream correction the policy holds back on. -------
    u2 = [
        hyp("i", "think"),
        hyp("i", "think", "its"),  # interim guess
        hyp("i", "think", "it's"),  # correction (its -> it's) — still interim
        hyp("i", "think", "it's", "fine"),
    ]
    seconds_seen = []
    for h in u2:
        r = p.update(h)
        all_committed.extend(r.committed)
        seconds_seen.append(r.committed_seconds)
    rf = p.flush()
    all_committed.extend(rf.committed)
    seconds_seen.append(rf.committed_seconds)
    per_utterance_seconds.append(seconds_seen)
    p.reset()

    # 1) Final transcript is exactly what we intended.
    assert words_of(all_committed) == "hey can you hear me i think it's fine"

    # 2) No duplicate finals: each (text, t_start, t_end) committed at most once.
    spans = [(t.text, t.t_start, t.t_end) for t in all_committed]
    assert len(spans) == len(set(spans)), f"duplicate finals: {spans}"

    # 3) committed_seconds is non-decreasing within each utterance.
    for seq in per_utterance_seconds:
        assert seq == sorted(seq), f"committed_seconds regressed: {seq}"

    # 4) No two committed spans WITHIN an utterance overlap (each starts at/after
    #    the previous one's end). We rebuild per-utterance commit order from the
    #    two reset-delimited segments by recomputing; here both utterances use a
    #    contiguous 0.5s grid so spans tile without overlap.
    # Utterance 1 spans: hey can you hear me -> 0..2.5 contiguous.
    u1_spans = spans[:5]
    for (_, _, e0), (_, s1, _) in zip(u1_spans, u1_spans[1:]):
        assert s1 >= e0
    # Utterance 2 spans: i think it's fine -> 0..2.0 contiguous.
    u2_spans = spans[5:]
    for (_, _, e0), (_, s1, _) in zip(u2_spans, u2_spans[1:]):
        assert s1 >= e0


def test_mid_word_correction_is_held_until_two_decodes_agree():
    # The classic LocalAgreement case: a word the model keeps revising must NOT
    # be committed until two consecutive decodes settle on the same surface form.
    p = LocalAgreementPolicy()
    p.update(hyp("call", "me"))
    r1 = p.update(hyp("call", "me", "ish"))  # commits "call me"; "ish" interim
    assert texts(r1.committed) == ["call", "me"]
    r2 = p.update(hyp("call", "me", "ismael"))  # "ish" was wrong, replaced
    assert r2.committed == []  # no agreement on the 3rd word yet
    assert texts(r2.partial) == ["ismael"]
    r3 = p.update(hyp("call", "me", "ishmael"))  # still changing
    assert r3.committed == []
    assert texts(r3.partial) == ["ishmael"]
    r4 = p.update(hyp("call", "me", "ishmael"))  # finally settled
    assert texts(r4.committed) == ["ishmael"]
    assert texts(p.committed) == ["call", "me", "ishmael"]


def test_independent_policy_instances_do_not_share_state():
    # mic ("You") and system ("They") get separate policy instances; one's
    # commits must never leak into the other.
    mic = LocalAgreementPolicy()
    system = LocalAgreementPolicy()
    mic.update(hyp("you", "said"))
    mic.update(hyp("you", "said"))
    system.update(hyp("they", "replied"))
    assert texts(mic.committed) == ["you", "said"]
    assert system.committed == []  # only one decode for system -> nothing final
    r_sys = system.update(hyp("they", "replied"))
    assert texts(r_sys.committed) == ["they", "replied"]
    # mic unaffected.
    assert texts(mic.committed) == ["you", "said"]
