"""Shared test scaffolding for the PRD-10 native on-device summary providers.

A FAKE helper that scripts the documented SUMMARY line/JSON protocol (mirror of
the ASR ``FakeHelper`` in test_transcription_engines.py), so the native providers
are exercised with NO Swift binary, NO Apple model, NO MLX, NO network. Imported
package-relatively (``from ._summary_helpers import ...``), matching ``_client``.
"""

from __future__ import annotations

import json
from typing import List, Optional


class FakeSummaryHelper:
    """A :class:`HelperProcess` scripting the SUMMARY protocol.

    Configure which ``engines`` the summary probe advertises and the ``text`` the
    generate step returns; ``fail_start`` / ``fail_generate`` script the helper's
    ``error`` reply so the provider's error mapping is exercised.
    """

    def __init__(
        self,
        *,
        engines: Optional[List[str]] = None,
        text: str = '{"tldr": "native on-device summary", "decisions": [], '
        '"action_items": [], "topics": []}',
        fail_start: bool = False,
        fail_generate: bool = False,
        die_on_generate: bool = False,
    ) -> None:
        self._engines = engines if engines is not None else ["apple-foundation", "apple-nl", "mlx"]
        self._text = text
        self._fail_start = fail_start
        self._fail_generate = fail_generate
        #: When set, this helper simulates a CRASHED/exited process: a
        #: ``summaryGenerate`` produces EOF (``read_line`` -> ``None``) instead of a
        #: result, so the warm pool must respawn + retry on a fresh helper.
        self._die_on_generate = die_on_generate
        self.sent: List[dict] = []
        self._outbox: List[str] = []
        self.closed = False

    def send_line(self, line: str) -> None:
        msg = json.loads(line)
        self.sent.append(msg)
        mtype = msg.get("type")
        if mtype == "summaryProbe":
            self._outbox.append(
                json.dumps(
                    {
                        "type": "summaryCapabilities",
                        "engines": self._engines,
                        "os": "darwin",
                        "arch": "arm64",
                    }
                )
            )
        elif mtype == "summaryStart":
            if self._fail_start:
                self._outbox.append(
                    json.dumps(
                        {"type": "error", "code": "unavailable", "message": "model unavailable"}
                    )
                )
            else:
                self._outbox.append(
                    json.dumps(
                        {
                            "type": "summaryReady",
                            "engine": msg.get("engine"),
                            "model": msg.get("model"),
                        }
                    )
                )
        elif mtype == "summaryGenerate":
            if self._fail_generate:
                self._outbox.append(
                    json.dumps({"type": "error", "code": "denied", "message": "generation denied"})
                )
            elif self._die_on_generate:
                pass  # no reply -> read_line returns None (EOF), simulating a crash.
            else:
                self._outbox.append(json.dumps({"type": "summaryResult", "text": self._text}))
        elif mtype == "summaryStop":
            pass

    def read_line(self) -> Optional[str]:
        if not self._outbox:
            return None
        return self._outbox.pop(0)

    def close(self) -> None:
        self.closed = True


def helper_factory(helper):
    """A ``HelperFactory`` returning a fixed helper (the injectable seam)."""
    return lambda: helper


class SpawningFactory:
    """A ``HelperFactory`` that mints a FRESH helper per call and records them, so a
    test can prove reuse (spawn once, many turns) vs respawn (a new process after a
    crash). ``helpers[i]`` is the i-th spawned helper; ``spawns`` is the count.

    ``configure`` is called with the spawn index and returns kwargs for
    :class:`FakeSummaryHelper`, so a test can, e.g., make the FIRST helper die on
    generate and the SECOND succeed.
    """

    def __init__(self, configure=None) -> None:
        self._configure = configure or (lambda i: {})
        self.helpers: List[FakeSummaryHelper] = []

    @property
    def spawns(self) -> int:
        return len(self.helpers)

    def __call__(self) -> FakeSummaryHelper:
        helper = FakeSummaryHelper(**self._configure(len(self.helpers)))
        self.helpers.append(helper)
        return helper
