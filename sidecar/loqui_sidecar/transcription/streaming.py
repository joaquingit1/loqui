"""LocalAgreement-2 streaming policy (PRD-2) — the incremental-stabilization core.

This is the trickiest correctness surface in PRD-2, so it is implemented as a
PURE, deterministic component: no model, no audio, no I/O, no clock. It operates
solely over a *sequence of ASR hypotheses* (each hypothesis is the full list of
timed tokens the backend produced for the current growing window) and decides
which prefix is now STABLE enough to emit as ``final`` vs. what is still interim
(``partial``). It is unit-tested in isolation (see tests/test_streaming_policy.py).

The policy ("LocalAgreement-n" with n=2, à la ufal/whisper_streaming, Macháček et
al. 2023):

    Commit the longest common prefix on which the **last two** consecutive
    hypotheses agree.

Concretely, each :meth:`update` is handed the backend's fresh full-window
hypothesis. The policy:

* drops the part of the new hypothesis that lies *inside* the already-committed
  prefix (matched by token count + a time guard), so it only ever reasons about
  *new* tokens beyond what is already final;
* compares the new hypothesis's un-committed tail against the PREVIOUS
  hypothesis's un-committed tail and finds their longest common prefix;
* that common prefix is newly STABLE → returned in ``committed`` (each token
  committed at most once, never retracted);
* the remaining un-committed, not-yet-stable tail of the new hypothesis is
  returned as ``partial`` (a replace-in-place best guess);
* stores the new hypothesis as "previous" for the next round.

:meth:`flush` (endpoint / stop) force-commits whatever interim tail remains —
there is no future hypothesis to agree with, so we trust the latest guess.

:meth:`reset` clears all state for a fresh utterance/window (the per-utterance
committed offset, the previous hypothesis, the committed time watermark).

Guarantees (relied on by the pipeline + asserted by the tests):

* a token is committed **at most once** (the committed prefix only grows);
* committed output is **monotonic** — never retracted;
* ``committed_seconds`` is **non-decreasing within an utterance** (it is the
  ``t_end`` of the last committed token, or the prior watermark if nothing new
  committed);
* ``committed`` and ``partial`` in a single result never overlap (partial is the
  strict tail after committed);
* identical / shrinking / empty hypotheses never produce spurious or duplicate
  commits.

Token comparison normalizes text (case-folded, surrounding whitespace stripped,
trailing sentence punctuation ignored) so cosmetic differences between two
otherwise-agreeing decodes do not block a commit; the *emitted* tokens keep their
original text and timestamps.
"""

from __future__ import annotations

import re
from typing import List, Optional

from .types import AsrToken, PolicyResult

__all__ = ["LocalAgreementPolicy", "normalize_token_text"]

#: Punctuation stripped from the END of a token for *agreement comparison* only
#: (the emitted token keeps its original text). Two decodes that differ only by a
#: trailing comma/period ("fox" vs. "fox.") should still agree on the word.
_TRAILING_PUNCT = ".,!?;:…。，？！"  # incl. CJK + ellipsis

_WS_RE = re.compile(r"\s+")


def normalize_token_text(text: str) -> str:
    """Normalize a token's text for AGREEMENT comparison (not for display).

    Case-folded, internal/edge whitespace collapsed, and trailing sentence
    punctuation removed. Used only to decide whether two tokens from consecutive
    decodes ``match``; the emitted :class:`AsrToken` retains its original text.
    """
    collapsed = _WS_RE.sub(" ", text).strip()
    folded = collapsed.casefold()
    return folded.rstrip(_TRAILING_PUNCT).strip()


def _tokens_match(a: AsrToken, b: AsrToken) -> bool:
    """Two tokens "agree" iff their normalized text is equal and non-empty.

    Pure text agreement (LocalAgreement compares the word sequence). Timestamps
    are not part of agreement — decode windows shift them slightly — but a
    normalized text that collapses to empty (pure punctuation/whitespace) never
    matches, so such tokens can never be committed on agreement alone.
    """
    na = normalize_token_text(a.text)
    nb = normalize_token_text(b.text)
    return bool(na) and na == nb


class LocalAgreementPolicy:
    """LocalAgreement-2 :class:`~loqui_sidecar.transcription.StreamingPolicy`.

    One instance per ``(meeting_id, source)`` pipeline — never shared across
    sources (mic/system stay independent). State is per-utterance and is wiped by
    :meth:`reset` at an utterance boundary or window reset.
    """

    def __init__(self) -> None:
        #: Tokens already emitted as ``final`` this utterance (the committed
        #: prefix). Only ever appended to within an utterance.
        self._committed: List[AsrToken] = []
        #: The previous round's full-window hypothesis (raw, from the backend),
        #: used to find the 2-decode agreement. ``None`` before the first update.
        self._prev: Optional[List[AsrToken]] = None
        #: Monotonic watermark: buffer-relative seconds up to which output is
        #: final. Non-decreasing within an utterance.
        self._committed_seconds: float = 0.0

    # -- StreamingPolicy protocol --------------------------------------------

    def update(self, tokens: List[AsrToken]) -> PolicyResult:
        """Ingest one fresh full-window hypothesis; return new finals + partial.

        ``tokens`` is the backend's complete decode of the current window (it
        normally *re-contains* the already-committed prefix because the window
        still holds that audio). We strip the committed prefix, then commit the
        longest common prefix shared with the previous hypothesis's tail.
        """
        new_hyp = list(tokens)

        # 1) Drop the part of the new hypothesis that re-covers what we already
        #    committed, so we only reason about genuinely-new tokens.
        tail = self._strip_committed_prefix(new_hyp)

        # 2) Find the prefix of `tail` on which it agrees with the PREVIOUS
        #    hypothesis's equivalent tail (LocalAgreement-2).
        prev_tail = self._strip_committed_prefix(self._prev) if self._prev is not None else []
        agree_len = self._common_prefix_len(prev_tail, tail)

        newly_committed = tail[:agree_len]
        if newly_committed:
            self._committed.extend(newly_committed)
            # committed_seconds is the end of the last committed token, but never
            # moves backwards (decode windows can wobble t_end slightly).
            self._committed_seconds = max(self._committed_seconds, newly_committed[-1].t_end)

        partial = tail[agree_len:]

        # 3) Remember this hypothesis for the next round.
        self._prev = new_hyp

        return PolicyResult(
            committed=newly_committed,
            partial=list(partial),
            committed_seconds=self._committed_seconds,
        )

    def flush(self) -> PolicyResult:
        """Force-commit the remaining interim tail (endpoint / stop).

        At an endpoint there is no future hypothesis to agree with, so the latest
        partial is the best (and final) guess. Commits the un-committed tail of
        the most recent hypothesis and returns it as ``committed`` with an empty
        ``partial``. Idempotent: a second flush with no new tokens commits
        nothing.
        """
        tail = self._strip_committed_prefix(self._prev) if self._prev is not None else []
        if tail:
            self._committed.extend(tail)
            self._committed_seconds = max(self._committed_seconds, tail[-1].t_end)
        # Nothing left interim after a flush.
        return PolicyResult(
            committed=list(tail),
            partial=[],
            committed_seconds=self._committed_seconds,
        )

    def reset(self) -> None:
        """Wipe all per-utterance state for a fresh utterance / window reset."""
        self._committed = []
        self._prev = None
        self._committed_seconds = 0.0

    # -- introspection (handy for the pipeline + tests) ----------------------

    @property
    def committed(self) -> List[AsrToken]:
        """The full committed (final) token sequence so far this utterance."""
        return list(self._committed)

    @property
    def committed_seconds(self) -> float:
        return self._committed_seconds

    # -- internals ------------------------------------------------------------

    def _strip_committed_prefix(self, hyp: List[AsrToken]) -> List[AsrToken]:
        """Return the part of ``hyp`` AFTER the already-committed prefix.

        The backend re-decodes the whole window, so a fresh hypothesis usually
        starts by repeating the committed words. We drop exactly the committed
        tokens off the front (matched by normalized text in order). To stay robust
        when a decode wobbles the very first word, we align greedily: walk the
        committed list and the hypothesis together, consuming a hypothesis token
        whenever it matches the next committed token; stop at the first committed
        token the hypothesis no longer contains in order. Whatever hypothesis
        tokens remain after the last matched committed token are the new tail.

        When nothing is committed yet, the whole hypothesis is the tail.
        """
        if not self._committed or not hyp:
            return list(hyp)

        ci = 0  # index into self._committed
        hi = 0  # index into hyp
        n_committed = len(self._committed)
        n_hyp = len(hyp)
        while ci < n_committed and hi < n_hyp:
            if _tokens_match(self._committed[ci], hyp[hi]):
                ci += 1
                hi += 1
            else:
                # The hypothesis token doesn't match the expected committed token.
                # Skip it only if it falls at/before the committed watermark (a
                # stale repeat of already-final audio); otherwise it is genuinely
                # new and the committed prefix has been fully consumed.
                if hyp[hi].t_end <= self._committed_seconds:
                    hi += 1
                else:
                    break
        return list(hyp[hi:])

    @staticmethod
    def _common_prefix_len(a: List[AsrToken], b: List[AsrToken]) -> int:
        """Length of the longest common prefix of two token lists by agreement."""
        n = min(len(a), len(b))
        i = 0
        while i < n and _tokens_match(a[i], b[i]):
            i += 1
        return i
