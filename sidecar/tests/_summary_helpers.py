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
    ) -> None:
        self._engines = engines if engines is not None else ["apple-foundation", "apple-nl", "mlx"]
        self._text = text
        self._fail_start = fail_start
        self._fail_generate = fail_generate
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
