"""Native on-device ASR backends (PRD-9) that drive a macOS Swift helper.

This is the Python side of the macOS-native engines (Apple Speech, WhisperKit /
MLX-Whisper). It does NO inference itself: it spawns a small notarizable Swift
helper binary (written under ``apps/desktop/native/macos/``, compiled + verified
on Mac/CI) and speaks a tiny **line-delimited JSON protocol** to it over the
helper's stdin/stdout, streaming 16 kHz mono pcm_s16le and reading back timed
tokens. The helper exposes Apple Speech (``SFSpeechRecognizer``,
``requiresOnDeviceRecognition = true``) and a WhisperKit/MLX (ANE) path, plus a
capability probe.

It conforms to the SAME PRD-2 :class:`~loqui_sidecar.transcription.types.AsrBackend`
seam (``transcribe(pcm) -> list[AsrToken]``), so the EXISTING per-source streaming
pipeline (VAD endpointing + LocalAgreement-2) drives it unchanged and the
two-stream You/They model stays intact — each ``(meeting, source)`` pipeline owns
its own backend instance (and thus its own helper process), so mic and system are
never cross-wired.

WINDOWING (per the PRD note): Whisper-family engines (WhisperKit / MLX / Parakeet)
decode a window like faster-whisper does, so LocalAgreement-2 applies as usual.
Apple Speech has its OWN segmentation, so its helper emits partial/final events;
this backend adapts the latest hypothesis to tokens per ``transcribe`` call and
lets the pipeline's flush commit them (rather than forcing LocalAgreement on top).
Both reduce to the same ``transcribe(pcm) -> tokens`` seam, so the pipeline is
engine-agnostic.

INJECTABILITY (testability): the helper subprocess is behind the
:class:`HelperProcess` protocol. Production uses :class:`SubprocessHelper` (spawns
the real binary); tests inject a FAKE helper that emits the documented protocol
with NO Swift binary. So the protocol parsing + the token mapping + the two-stream
routing are all verified hermetically on Windows; only the real Swift compile +
the real Apple Speech run are Mac/CI-only (an opt-in test, skipped here).

--------------------------------------------------------------------------------
HELPER LINE/JSON PROTOCOL (host == Python sidecar; helper == the Swift binary)
--------------------------------------------------------------------------------
One JSON object per line (``\n``-terminated, UTF-8), both directions. PCM is sent
base64-encoded inside an ``audio`` request so the whole channel is a single
line-oriented stream (simple + testable). All timestamps are seconds relative to
the START of the buffer handed in the current decode (buffer-relative), matching
:class:`~loqui_sidecar.transcription.types.AsrToken`; the pipeline shifts them
onto the meeting timeline.

Host -> helper:
  {"type": "probe"}
      Ask which engines this OS/arch supports. The helper replies with
      ``capabilities`` and (for ``probe``) exits or stays ready per the host.
  {"type": "start", "engine": "apple-speech"|"whisperkit"|"mlx-whisper"|"parakeet",
                    "modelSize": "tiny"|"base"|"small"|"medium"|"large"|null,
                    "language": "en"|null, "sampleRate": 16000}
      Begin a streaming session for one source with the chosen engine.
  {"type": "decode", "pcmBase64": "<base64 pcm_s16le>"}
      Decode this window (the whole current utterance buffer). The helper replies
      with exactly ONE ``tokens`` message carrying the hypothesis for this window.
  {"type": "stop"}
      End the session (flush + release the recognizer).

Helper -> host:
  {"type": "ready", "engine": "...", "version": "..."}
      Sent once after a successful ``start`` (or helper launch).
  {"type": "capabilities", "engines": ["apple-speech", "whisperkit", ...],
                           "os": "darwin", "arch": "arm64"}
      Reply to ``probe``: the engines available on this host.
  {"type": "tokens", "tokens": [{"text": "hello", "tStart": 0.0, "tEnd": 0.4},
                                ...], "final": true|false}
      The decode result for the most recent ``decode`` (one per ``decode``).
      ``final`` flags an Apple-Speech final result (advisory; the pipeline's own
      endpointing still owns commit timing through LocalAgreement-2's flush).
  {"type": "error", "code": "...", "message": "..."}
      A recoverable error (e.g. permission denied). The backend degrades the
      affected decode to "no tokens" and logs; it never crashes the meeting.

The host always reads lines until it sees the response that matches its request
(``capabilities`` for ``probe``; ``tokens`` for ``decode``), tolerating and
logging any unrecognized line (forward-compatible).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
import subprocess
from typing import Callable, List, Optional, Protocol, runtime_checkable

from .types import AUDIO_SAMPLE_RATE, AsrBackend, AsrToken

logger = logging.getLogger("loqui_sidecar.transcription.native")

#: Env var pointing at the macOS Swift helper binary (set by the packaged app /
#: PRD-8 bundling). When unset we fall back to looking up ``loqui-asr-helper`` on
#: PATH. On Windows this is always absent, so native engines never resolve a
#: helper and the selector falls back to faster-whisper.
HELPER_BIN_ENV = "LOQUI_ASR_HELPER_BIN"

#: Default helper binary name (looked up via shutil.which when the env is unset).
DEFAULT_HELPER_NAME = "loqui-asr-helper"

#: Engines this native backend can drive through the helper.
NATIVE_ENGINES = ("apple-speech", "whisperkit", "mlx-whisper", "parakeet")


# --- The injectable helper-process seam ---------------------------------------


@runtime_checkable
class HelperProcess(Protocol):
    """A line-oriented duplex channel to the ASR helper (injectable for tests).

    Production: :class:`SubprocessHelper` over a spawned Swift binary's
    stdin/stdout. Tests: a fake that scripts the documented protocol with no
    binary. ``send_line`` writes one JSON line; ``read_line`` blocks for the next
    JSON line (or returns ``None`` at EOF); ``close`` releases the process.
    """

    def send_line(self, line: str) -> None: ...

    def read_line(self) -> Optional[str]: ...

    def close(self) -> None: ...


class SubprocessHelper:
    """A :class:`HelperProcess` backed by a real spawned helper binary.

    Spawns ``binary`` with piped stdin/stdout (text mode, line-buffered) and
    speaks the line/JSON protocol. Construction does NOT spawn — :meth:`start`
    does, lazily — so merely importing/constructing is cheap and the hermetic gate
    never launches a process. Never raises on construction.
    """

    def __init__(self, binary: str) -> None:
        self._binary = binary
        self._proc: Optional[subprocess.Popen] = None

    def start(self) -> None:
        if self._proc is not None:
            return
        # Line-buffered text pipes so each JSON line flushes promptly.
        self._proc = subprocess.Popen(  # noqa: S603 - binary is a resolved path we control.
            [self._binary],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def send_line(self, line: str) -> None:
        if self._proc is None:
            self.start()
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.write(line if line.endswith("\n") else line + "\n")
        self._proc.stdin.flush()

    def read_line(self) -> Optional[str]:
        if self._proc is None or self._proc.stdout is None:
            return None
        line = self._proc.stdout.readline()
        if line == "":
            return None  # EOF
        return line.rstrip("\n")

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception:  # noqa: BLE001 - best-effort close.
            pass
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:  # noqa: BLE001 - last-resort kill.
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass


#: A factory that builds a fresh :class:`HelperProcess` for one backend instance
#: (and thus one source). Injected so tests pass a fake-helper factory.
HelperFactory = "callable returning HelperProcess"


def resolve_helper_binary() -> Optional[str]:
    """Locate the macOS ASR helper binary, or ``None`` if not present.

    Honors :data:`HELPER_BIN_ENV` (the packaged path), else looks up
    :data:`DEFAULT_HELPER_NAME` on PATH. On Windows / when nothing is found this
    returns ``None``, which is exactly the signal the selector uses to fall back
    to faster-whisper. Never raises.
    """
    explicit = os.environ.get(HELPER_BIN_ENV)
    if explicit and os.path.isfile(explicit):
        return explicit
    found = shutil.which(DEFAULT_HELPER_NAME)
    return found


def _default_subprocess_factory():
    """Default :data:`HelperFactory`: spawn the resolved Swift helper binary.

    Returns ``None`` when no helper binary is available (Windows or unbundled), so
    the caller treats the native engine as unavailable and falls back.
    """
    binary = resolve_helper_binary()
    if binary is None:
        return None

    def factory() -> HelperProcess:
        return SubprocessHelper(binary)

    return factory


def probe_capabilities(helper_factory=None) -> List[str]:
    """Ask the helper which native engines are available on this OS/arch.

    Spawns a short-lived helper (via ``helper_factory`` or the default
    subprocess factory), sends ``{"type":"probe"}``, and returns the engine list
    from the ``capabilities`` reply. Returns ``[]`` when no helper is available
    (Windows / unbundled) or on any error — the empty list is the "no native
    engines" signal the selector falls back on. Never raises.
    """
    factory = helper_factory or _default_subprocess_factory()
    if factory is None:
        return []
    helper: Optional[HelperProcess] = None
    try:
        helper = factory()
        helper.send_line(json.dumps({"type": "probe"}))
        for _ in range(64):  # bounded: tolerate a few unrelated lines.
            raw = helper.read_line()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if isinstance(msg, dict) and msg.get("type") == "capabilities":
                engines = msg.get("engines")
                if isinstance(engines, list):
                    return [e for e in engines if isinstance(e, str)]
                return []
        return []
    except Exception:  # noqa: BLE001 - a probe failure is "no native engines".
        logger.warning("native ASR capability probe failed", exc_info=True)
        return []
    finally:
        if helper is not None:
            try:
                helper.close()
            except Exception:  # noqa: BLE001
                pass


class NativeHelperBackend:
    """A native-engine :class:`AsrBackend` driving the Swift helper.

    One instance per ``(meeting, source)`` pipeline (so each owns its own helper
    process — mic and system never share a recognizer). Conforms to the PRD-2
    ``transcribe(pcm) -> list[AsrToken]`` seam so the existing streaming pipeline
    drives it unchanged.

    ``helper_factory`` builds the duplex channel; inject a fake in tests. When the
    factory is ``None`` (no helper binary), :meth:`load` raises so the selector's
    construction-time guard falls back to faster-whisper — a missing helper never
    reaches a meeting.
    """

    def __init__(
        self,
        engine: str,
        *,
        model_size: Optional[str] = None,
        language: Optional[str] = None,
        helper_factory=None,
        sample_rate: int = AUDIO_SAMPLE_RATE,
    ) -> None:
        self._engine = engine
        self._model_size = model_size
        self._language = language
        self._sample_rate = sample_rate
        # Default to the real subprocess factory; tests inject a fake. A None
        # factory means "no helper available" -> load() raises -> selector falls back.
        self._factory = (
            helper_factory if helper_factory is not None else _default_subprocess_factory()
        )
        self._helper: Optional[HelperProcess] = None
        self._loaded = False
        self._error: Optional[str] = None

    # -- AsrBackend protocol --------------------------------------------------

    @property
    def name(self) -> str:
        size = f":{self._model_size}" if self._model_size else ""
        return f"native:{self._engine}{size}"

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        """Spawn the helper + send ``start``; wait for the ``ready`` reply.

        Idempotent. Raises if no helper factory is available (caller falls back)
        or the helper fails to become ready, recording the reason in
        :attr:`status`.
        """
        if self._loaded:
            return
        if self._factory is None:
            self._error = "no ASR helper binary available"
            raise RuntimeError(self._error)
        helper = self._factory()
        start = {
            "type": "start",
            "engine": self._engine,
            "modelSize": self._model_size,
            "language": self._language,
            "sampleRate": self._sample_rate,
        }
        helper.send_line(json.dumps(start))
        # Wait (bounded) for a ``ready`` ack so a broken helper surfaces here, not
        # mid-meeting. An ``error`` reply (e.g. permission denied) fails the load
        # so the selector can fall back.
        for _ in range(64):
            raw = helper.read_line()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "ready":
                self._helper = helper
                self._loaded = True
                self._error = None
                return
            if mtype == "error":
                self._error = f"{msg.get('code')}: {msg.get('message')}"
                break
        try:
            helper.close()
        except Exception:  # noqa: BLE001
            pass
        if self._error is None:
            self._error = "helper did not become ready"
        raise RuntimeError(self._error)

    def transcribe(
        self,
        pcm: bytes,
        sample_rate: int = AUDIO_SAMPLE_RATE,
        language: Optional[str] = None,
        # Accepted for AsrBackend parity. The native helper is configured with a
        # fixed language at construction (no per-window auto-detect), so the lock
        # sink is never invoked here.
        on_language: Optional[Callable[[str], None]] = None,
    ) -> List[AsrToken]:
        """Decode one window through the helper -> buffer-relative tokens.

        Sends a ``decode`` with the base64 PCM and reads back the single
        ``tokens`` reply, mapping each to an :class:`AsrToken`. A helper error or
        EOF degrades to an empty list (a dropped window) — never an exception that
        could tear down the pipeline. Does NOT mutate/retain ``pcm``.
        """
        if not self._loaded:
            self.load()
        helper = self._helper
        if helper is None:
            return []
        try:
            payload = base64.b64encode(bytes(pcm)).decode("ascii")
            helper.send_line(json.dumps({"type": "decode", "pcmBase64": payload}))
            for _ in range(64):
                raw = helper.read_line()
                if raw is None:
                    return []
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                mtype = msg.get("type")
                if mtype == "tokens":
                    return _tokens_from_message(msg)
                if mtype == "error":
                    logger.warning(
                        "native ASR helper error during decode: %s/%s",
                        msg.get("code"),
                        msg.get("message"),
                    )
                    return []
                # Unrecognized line (e.g. a stray ``ready``/``partial``): skip.
            return []
        except Exception:  # noqa: BLE001 - a decode error degrades to a dropped window.
            logger.warning("native ASR decode failed", exc_info=True)
            return []

    def close(self) -> None:
        helper = self._helper
        self._helper = None
        self._loaded = False
        if helper is not None:
            try:
                helper.close()
            except Exception:  # noqa: BLE001
                pass

    # -- /health surface ------------------------------------------------------

    @property
    def status(self) -> dict:
        if self._loaded:
            state = "loaded"
        elif self._error is not None:
            state = "error"
        else:
            state = "unloaded"
        return {
            "name": self.name,
            "state": state,
            "engine": self._engine,
            "model_size": self._model_size,
            "error": self._error,
        }


def _tokens_from_message(msg: dict) -> List[AsrToken]:
    """Map a ``tokens`` protocol message to :class:`AsrToken` (robust to junk)."""
    out: List[AsrToken] = []
    raw_tokens = msg.get("tokens")
    if not isinstance(raw_tokens, list):
        return out
    for t in raw_tokens:
        if not isinstance(t, dict):
            continue
        text = t.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            t_start = float(t.get("tStart", 0.0))
            t_end = float(t.get("tEnd", t_start))
        except (TypeError, ValueError):
            continue
        out.append(AsrToken(text=text.strip(), t_start=t_start, t_end=t_end))
    return out


# Static conformance check: NativeHelperBackend satisfies the AsrBackend protocol
# (no spawn — construction with a None factory is cheap + import-light).
_check: AsrBackend = NativeHelperBackend("apple-speech", helper_factory=None)
