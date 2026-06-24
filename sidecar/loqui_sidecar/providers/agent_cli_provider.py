"""Local agent-CLI :class:`ChatProvider` (PRD-4 build unit).

Shells out to a locally-installed agent CLI in headless/print mode and streams its
stdout back as text deltas. Two CLIs are supported (selected by
``ProviderConfig.cli``):

* ``claude`` — Claude Code: ``claude -p "<prompt>" --output-format stream-json
  --verbose``. Emits newline-delimited JSON events; the assistant text arrives as
  ``content`` blocks inside ``{"type": "assistant", ...}`` events (and any
  ``{"type": "...", "text": ...}`` deltas). We extract text incrementally.
* ``codex`` — Codex: ``codex exec "<prompt>"`` in headless mode; plain stdout is
  streamed line-by-line.

Availability is detected with :func:`shutil.which`; an absent CLI raises a stable,
actionable :class:`ChatProviderError` (``cli_not_found``) rather than crashing. A
non-zero exit (with whatever partial output already streamed) maps to
``cli_error`` — already-yielded deltas stand and the handler emits ``chatError``.

The CLI receives the conversation rendered into a single prompt string, including
the READ-ONLY transcript context (folded into ``messages`` by the handler). It is
handed no transcript writer and no path to mutate any transcript/meta file.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from typing import Iterator, Optional

from .types import ChatMessage, ChatProviderError, ProviderConfig

#: Supported CLIs and how to launch them in headless/print streaming mode. The
#: prompt is appended as the final positional arg.
_CLI_NOT_FOUND = {
    "claude": "Claude Code CLI ('claude') is not installed or not on PATH. "
    "Install it, or pick a different provider in Settings.",
    "codex": "Codex CLI ('codex') is not installed or not on PATH. "
    "Install it, or pick a different provider in Settings.",
}


def _build_argv(cli: str, prompt: str) -> list[str]:
    """Build the headless/streaming argv for ``cli`` (resolved binary + flags)."""
    binary = shutil.which(cli)
    if binary is None:
        raise ChatProviderError(
            "cli_not_found",
            _CLI_NOT_FOUND.get(cli, f"Agent CLI {cli!r} is not installed or not on PATH."),
        )
    if cli == "claude":
        # stream-json requires --verbose; -p is print/headless mode.
        return [binary, "-p", "--output-format", "stream-json", "--verbose", prompt]
    if cli == "codex":
        return [binary, "exec", prompt]
    raise ChatProviderError("cli_not_found", f"Unsupported agent CLI {cli!r}.")


def render_prompt(messages: list[ChatMessage]) -> str:
    """Flatten the conversation (incl. the read-only context system message) into
    a single prompt string for the CLI. Read-only: builds a string only.
    """
    parts: list[str] = []
    for m in messages:
        if not m.content:
            continue
        if m.role == "system":
            parts.append(m.content)
        elif m.role == "assistant":
            parts.append(f"Assistant: {m.content}")
        else:
            parts.append(f"User: {m.content}")
    return "\n\n".join(parts)


def _extract_claude_text(obj: dict) -> Iterator[str]:
    """Pull assistant text out of one ``claude --output-format stream-json`` event.

    Handles both the assistant-message envelope (``{"type":"assistant","message":
    {"content":[{"type":"text","text":...}]}}``) and any flat ``{"text": ...}``
    delta events. Tool-use / system / result events yield nothing.
    """
    etype = obj.get("type")
    if etype == "assistant":
        message = obj.get("message") or {}
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if text:
                    yield text
        return
    # Some stream-json variants emit incremental text deltas at the top level.
    if etype in (None, "text", "content_block_delta"):
        text = obj.get("text")
        if not text:
            delta = obj.get("delta")
            if isinstance(delta, dict):
                text = delta.get("text")
        if text:
            yield text


class AgentCliProvider:
    """Subprocess-backed chat provider over an installed ``claude`` / ``codex``.

    ``runner`` is a test seam: a callable ``(argv) -> iterable_of_(line, ...)``
    plus an exit code — defaults to a real :func:`subprocess.Popen`. Tests inject a
    fake runner to assert argv shaping + streaming with no real process.
    """

    def __init__(self, config: ProviderConfig, runner=None) -> None:
        self._cli = (config.cli or "claude").strip() or "claude"
        self._runner = runner

    @property
    def name(self) -> str:
        return f"agent-cli:{self._cli}"

    def stream_chat(
        self,
        messages: list[ChatMessage],
        config: ProviderConfig,
        api_key: Optional[str] = None,
    ) -> Iterator[str]:
        prompt = render_prompt(messages)
        argv = _build_argv(self._cli, prompt)
        is_claude = self._cli == "claude"

        if self._runner is not None:
            yield from self._stream_runner(argv, is_claude)
            return
        yield from self._stream_subprocess(argv, is_claude)

    def _parse_line(self, line: str, is_claude: bool) -> Iterator[str]:
        line = line.rstrip("\n")
        if not line:
            return
        if not is_claude:
            # codex exec: plain text stdout, stream line-by-line.
            yield line + "\n"
            return
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            return  # non-JSON noise on the stream-json channel.
        yield from _extract_claude_text(obj)

    def _stream_runner(self, argv: list[str], is_claude: bool) -> Iterator[str]:
        lines, returncode = self._runner(argv)
        for line in lines:
            yield from self._parse_line(line, is_claude)
        if returncode:
            raise ChatProviderError(
                "cli_error",
                f"Agent CLI {self._cli!r} exited with code {returncode}.",
            )

    def _stream_subprocess(self, argv: list[str], is_claude: bool) -> Iterator[str]:
        try:
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except (OSError, ValueError) as exc:  # binary vanished between which() and exec.
            raise ChatProviderError(
                "cli_not_found",
                f"Could not launch agent CLI {self._cli!r}: {type(exc).__name__}.",
            ) from None

        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                yield from self._parse_line(line, is_claude)
        finally:
            proc.stdout and proc.stdout.close()
            returncode = proc.wait()

        if returncode:
            raise ChatProviderError(
                "cli_error",
                f"Agent CLI {self._cli!r} exited with code {returncode}.",
            )


def agent_cli_factory(config: ProviderConfig) -> AgentCliProvider:
    """Build an agent-CLI provider for ``config`` (for ``make_provider_selector``)."""
    return AgentCliProvider(config)
