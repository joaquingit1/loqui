"""PRD-9 pluggable-transcription-engine tests (hermetic, no Swift, no model).

Covers:

* the native-engine :class:`NativeHelperBackend` driving a MOCK helper process
  that speaks the documented line/JSON protocol (probe / start / decode / tokens /
  error) -> asserts the protocol parses to the right ``AsrToken``s;
* the same backend driven THROUGH the real PRD-2 streaming pipeline -> asserts the
  helper's tokens become ``partial``/``final`` ``TranscriptSegment``s and that the
  two-stream You/They model stays intact (mic and system never cross-wired);
* the engine selector + its fallback: default -> faster-whisper; a macOS-native
  engine on Windows -> faster-whisper (with a note); a native engine whose probe
  says "available" -> the native backend; ``LOQUI_FAKE_ASR`` overrides everything.

The Swift helper is NEVER compiled or run here — a Python FAKE helper emits the
protocol. The real Apple Speech run is a separate opt-in test
(``test_apple_speech_real.py``), skipped unless macOS + an env flag.
"""

from __future__ import annotations

import json
from typing import List, Optional

import pytest

from loqui_sidecar.transcription import (
    AsrBackend,
    AsrToken,
    NativeHelperBackend,
    TranscriptionManager,
    TranscriptSegment,
    probe_capabilities,
)
from loqui_sidecar.transcription.engine_select import (
    DEFAULT_ENGINE,
    resolve_engine_selection,
    select_backend,
)
from loqui_sidecar.transcription.native_backend import HelperProcess
from loqui_sidecar.transcription.pipeline import PipelineConfig, make_pipeline_factory

# --- A scripted FAKE helper process (no Swift, no subprocess) ------------------


class FakeHelper:
    """A :class:`HelperProcess` that scripts the documented line/JSON protocol.

    Configure which ``engines`` the probe advertises, and a ``phrase`` revealed
    word-by-word as the decoded window grows — exactly the "stable repeat"
    LocalAgreement-2 needs. Each ``decode`` is answered with ONE ``tokens`` line.
    Records every line sent (so tests can assert the host spoke the protocol).
    """

    def __init__(
        self,
        *,
        engines: Optional[List[str]] = None,
        phrase: Optional[List[str]] = None,
        fail_start: bool = False,
        seconds_per_word: float = 0.25,
    ) -> None:
        self._engines = engines if engines is not None else ["apple-speech", "whisperkit"]
        self._phrase = phrase or ["hello", "there", "this", "is", "native"]
        self._fail_start = fail_start
        self._spw = seconds_per_word
        self.sent: List[dict] = []
        self._outbox: List[str] = []
        self.closed = False

    def send_line(self, line: str) -> None:
        msg = json.loads(line)
        self.sent.append(msg)
        mtype = msg.get("type")
        if mtype == "probe":
            self._outbox.append(
                json.dumps(
                    {
                        "type": "capabilities",
                        "engines": self._engines,
                        "os": "darwin",
                        "arch": "arm64",
                    }
                )
            )
        elif mtype == "start":
            if self._fail_start:
                self._outbox.append(
                    json.dumps({"type": "error", "code": "denied", "message": "permission denied"})
                )
            else:
                self._outbox.append(
                    json.dumps({"type": "ready", "engine": msg.get("engine"), "version": "test"})
                )
        elif mtype == "decode":
            self._outbox.append(self._tokens_for(msg.get("pcmBase64", "")))
        elif mtype == "stop":
            pass

    def read_line(self) -> Optional[str]:
        if not self._outbox:
            return None
        return self._outbox.pop(0)

    def close(self) -> None:
        self.closed = True

    def _tokens_for(self, pcm_b64: str) -> str:
        import base64

        n_bytes = len(base64.b64decode(pcm_b64)) if pcm_b64 else 0
        seconds = (n_bytes // 2) / 16000.0
        words = max(1, min(int(seconds / self._spw) or 1, len(self._phrase)))
        tokens = [
            {"text": self._phrase[i], "tStart": i * self._spw, "tEnd": (i + 1) * self._spw}
            for i in range(words)
        ]
        return json.dumps({"type": "tokens", "tokens": tokens, "final": False})


def _factory(helper: HelperProcess):
    return lambda: helper


# --- Native backend: protocol parsing -----------------------------------------


def test_native_backend_satisfies_asr_protocol():
    backend = NativeHelperBackend("whisperkit", helper_factory=_factory(FakeHelper()))
    assert isinstance(backend, AsrBackend)
    assert backend.is_loaded is False


def test_native_backend_load_handshakes_and_is_loaded():
    helper = FakeHelper()
    backend = NativeHelperBackend("apple-speech", helper_factory=_factory(helper))
    backend.load()
    assert backend.is_loaded is True
    # The host sent a ``start`` with the engine.
    start = next(m for m in helper.sent if m["type"] == "start")
    assert start["engine"] == "apple-speech"


def test_native_backend_decode_maps_tokens_message_to_asr_tokens():
    helper = FakeHelper(phrase=["alpha", "bravo", "charlie"])
    backend = NativeHelperBackend("whisperkit", helper_factory=_factory(helper))
    backend.load()
    # ~0.75 s of audio -> 3 words revealed (seconds_per_word default 0.25).
    pcm = b"\x10\x27" * int(16000 * 0.75)  # constant nonzero sample, 0.75 s mono.
    tokens = backend.transcribe(pcm)
    assert [t.text for t in tokens] == ["alpha", "bravo", "charlie"]
    assert all(isinstance(t, AsrToken) for t in tokens)
    assert tokens[0].t_start == 0.0


def test_native_backend_decode_grows_with_buffer():
    helper = FakeHelper(phrase=["one", "two", "three", "four"])
    backend = NativeHelperBackend("mlx-whisper", helper_factory=_factory(helper))
    backend.load()
    short = backend.transcribe(b"\x10\x27" * int(16000 * 0.25))  # ~1 word
    longer = backend.transcribe(b"\x10\x27" * int(16000 * 1.0))  # ~4 words
    assert len(short) < len(longer)
    # Stable prefix: the longer decode repeats the shorter decode's prefix.
    assert [t.text for t in longer][: len(short)] == [t.text for t in short]


def test_native_backend_load_failure_raises_for_fallback():
    # A helper that errors on start (e.g. permission denied) must raise from
    # load() so the selector / pipeline can fall back — never silently wedge.
    helper = FakeHelper(fail_start=True)
    backend = NativeHelperBackend("apple-speech", helper_factory=_factory(helper))
    with pytest.raises(RuntimeError):
        backend.load()
    assert backend.status["state"] == "error"


def test_native_backend_no_helper_factory_raises_on_load():
    # No helper binary available (Windows / unbundled): load() raises so the
    # selector falls back to faster-whisper.
    backend = NativeHelperBackend("whisperkit", helper_factory=None)
    # The default subprocess factory finds no binary on this host -> None.
    backend._factory = None  # simulate "no helper" deterministically.
    with pytest.raises(RuntimeError):
        backend.load()


def test_native_backend_decode_error_degrades_to_empty(monkeypatch):
    helper = FakeHelper()
    backend = NativeHelperBackend("whisperkit", helper_factory=_factory(helper))
    backend.load()

    # A helper that returns an ``error`` line for a decode -> empty token list,
    # never an exception.
    def erroring_send(line: str) -> None:
        msg = json.loads(line)
        if msg.get("type") == "decode":
            helper._outbox.append(json.dumps({"type": "error", "code": "x", "message": "boom"}))

    helper.send_line = erroring_send  # type: ignore[method-assign]
    assert backend.transcribe(b"\x10\x27" * 16000) == []


# --- Capability probe ---------------------------------------------------------


def test_probe_capabilities_returns_helper_engines():
    helper = FakeHelper(engines=["apple-speech", "whisperkit", "mlx-whisper"])
    engines = probe_capabilities(_factory(helper))
    assert engines == ["apple-speech", "whisperkit", "mlx-whisper"]


def test_probe_capabilities_no_helper_is_empty():
    # No factory -> no helper -> empty list (the "no native engines" fallback).
    assert probe_capabilities(None) == []


# --- The selector + fallback --------------------------------------------------


def test_select_backend_default_is_faster_whisper(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    monkeypatch.delenv("LOQUI_TRANSCRIPTION_ENGINE", raising=False)
    from loqui_sidecar.transcription.asr_backend import FasterWhisperBackend

    selection = select_backend()
    backend = selection.factory()
    assert selection.shareable is True
    assert isinstance(backend, FasterWhisperBackend)
    assert backend.is_loaded is False  # lazy: nothing downloaded.


def test_select_backend_fake_env_overrides_engine(monkeypatch):
    monkeypatch.setenv("LOQUI_FAKE_ASR", "1")
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_ENGINE", "apple-speech")
    selection = select_backend()
    backend = selection.factory()
    assert selection.shareable is True
    # The hermetic fake wins regardless of the engine choice.
    assert backend.name.startswith("fake")


def test_select_backend_macos_engine_falls_back_off_darwin(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_ENGINE", "apple-speech")
    # Force non-darwin so the macOS-only engine falls back (this is the Windows
    # path; on a real Mac CI the probe gate handles availability instead).
    monkeypatch.setattr("loqui_sidecar.transcription.engine_select._is_darwin", lambda: False)
    from loqui_sidecar.transcription.asr_backend import FasterWhisperBackend

    selection = resolve_engine_selection()
    assert selection.active_engine == DEFAULT_ENGINE
    assert selection.fell_back is True
    assert "macOS-only" in selection.reason
    selection = select_backend()
    assert selection.shareable is True
    assert isinstance(selection.factory(), FasterWhisperBackend)


def test_select_backend_native_engine_when_probe_available(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_ENGINE", "whisperkit")
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_MODEL_SIZE", "base")
    # Pretend we are on darwin and the helper advertises whisperkit.
    monkeypatch.setattr("loqui_sidecar.transcription.engine_select._is_darwin", lambda: True)
    helper = FakeHelper(engines=["whisperkit", "apple-speech"])
    selection = select_backend(helper_factory=_factory(helper))
    backend = selection.factory()
    assert selection.shareable is False
    assert isinstance(backend, NativeHelperBackend)
    assert backend.name == "native:whisperkit:base"


def test_select_backend_native_engine_unavailable_falls_back(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_ENGINE", "whisperkit")
    monkeypatch.setattr("loqui_sidecar.transcription.engine_select._is_darwin", lambda: True)
    # The probe advertises NOTHING -> fall back to faster-whisper.
    helper = FakeHelper(engines=[])
    from loqui_sidecar.transcription.asr_backend import FasterWhisperBackend

    selection = select_backend(helper_factory=_factory(helper))
    backend = selection.factory()
    assert selection.shareable is True
    assert isinstance(backend, FasterWhisperBackend)


def test_apple_speech_engine_ignores_model_size(monkeypatch):
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_ENGINE", "apple-speech")
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_MODEL_SIZE", "large")
    monkeypatch.setattr("loqui_sidecar.transcription.engine_select._is_darwin", lambda: True)
    helper = FakeHelper(engines=["apple-speech"])
    selection = select_backend(helper_factory=_factory(helper))
    backend = selection.factory()
    assert selection.shareable is False
    assert isinstance(backend, NativeHelperBackend)
    # apple-speech has no selectable Whisper model size.
    assert backend.name == "native:apple-speech"


# --- End-to-end through the PRD-2 streaming pipeline (two streams intact) ------


def _marker_frame(source: str, seq: int):
    """A speech-amplitude frame for one source (loud enough to pass EnergyVad)."""
    from loqui_sidecar.audio_ingest import DecodedFrame

    # 0.25 s of a constant loud sample so the VAD sees speech and the fake helper
    # reveals one more word per ~0.25 s window.
    sample = b"\x10\x27"  # 10000, well above the EnergyVad threshold.
    pcm = sample * int(16000 * 0.25)
    return DecodedFrame(source=source, seq=seq, timestamp_ms=seq * 250.0, pcm=pcm)


def test_native_backend_drives_pipeline_and_keeps_two_streams_separate(monkeypatch):
    # Distinct phrases per source prove mic ("You") and system ("They") never
    # cross-wire when routed through the production manager selection path:
    # native selection is non-shareable, so each source receives a fresh backend
    # and helper.
    monkeypatch.delenv("LOQUI_FAKE_ASR", raising=False)
    monkeypatch.setenv("LOQUI_TRANSCRIPTION_ENGINE", "whisperkit")
    monkeypatch.setattr("loqui_sidecar.transcription.engine_select._is_darwin", lambda: True)
    helper_phrases = iter(
        [
            ["probe"],
            ["you", "said", "hello"],
            ["they", "said", "goodbye"],
        ]
    )
    helpers: List[FakeHelper] = []

    def helper_factory() -> FakeHelper:
        helper = FakeHelper(engines=["whisperkit"], phrase=next(helper_phrases))
        helpers.append(helper)
        return helper

    selection = select_backend(helper_factory=helper_factory)
    assert selection.shareable is False

    emitted: List[TranscriptSegment] = []
    pipe_cfg = PipelineConfig(decode_interval_seconds=0.2, min_decode_seconds=0.2)
    pipe_factory = make_pipeline_factory(pipe_cfg)
    backends: dict[str, AsrBackend] = {}

    def factory(meeting_id, source, emit, backend, transcription_config):
        backends[source] = backend
        return pipe_factory(meeting_id, source, emit, backend, transcription_config)

    mgr = TranscriptionManager(
        emit=emitted.append,
        backend_factory=selection.factory,
        backend_shareable=selection.shareable,
        pipeline_factory=factory,
    )
    mgr.on_start("m-1", "mic")
    mgr.on_start("m-1", "system")
    # Feed several speech windows + a couple of silence frames to force endpoints.
    for i in range(6):
        mgr.on_frame("m-1", "mic", _marker_frame("mic", i))
        mgr.on_frame("m-1", "system", _marker_frame("system", i))
    mgr.on_stop("m-1", "mic")
    mgr.on_stop("m-1", "system")

    assert emitted, "expected transcript segments from the native backends"
    assert backends["mic"] is not backends["system"]
    assert isinstance(backends["mic"], NativeHelperBackend)
    assert isinstance(backends["system"], NativeHelperBackend)
    assert helpers[1] is not helpers[2]
    assert helpers[1].closed is True
    assert helpers[2].closed is True
    mic_text = " ".join(s.text for s in emitted if s.source == "mic")
    sys_text = " ".join(s.text for s in emitted if s.source == "system")
    # Each stream carries ONLY its own phrase's words — never the other's.
    assert "you" in mic_text and "they" not in mic_text
    assert "they" in sys_text and "you" not in sys_text
    # A final segment was committed for each source under a stable, per-source id.
    finals = [s for s in emitted if s.status == "final"]
    assert {s.source for s in finals} == {"mic", "system"}
    assert all(s.source in s.seg_id for s in finals)


def test_shareable_backend_selection_is_reused_across_sources(monkeypatch):
    monkeypatch.setenv("LOQUI_FAKE_ASR", "1")
    selection = select_backend()
    assert selection.shareable is True

    built: List[AsrBackend] = []

    def backend_factory() -> AsrBackend:
        backend = selection.factory()
        built.append(backend)
        return backend

    pipe_cfg = PipelineConfig(decode_interval_seconds=0.2, min_decode_seconds=0.2)
    pipe_factory = make_pipeline_factory(pipe_cfg)
    backends: dict[str, AsrBackend] = {}

    def factory(meeting_id, source, emit, backend, transcription_config):
        backends[source] = backend
        return pipe_factory(meeting_id, source, emit, backend, transcription_config)

    mgr = TranscriptionManager(
        backend_factory=backend_factory,
        backend_shareable=selection.shareable,
        pipeline_factory=factory,
    )
    mgr.on_start("m-1", "mic")
    mgr.on_start("m-1", "system")
    mgr.on_stop("m-1", "mic")
    mgr.on_stop("m-1", "system")

    assert len(built) == 1
    assert backends["mic"] is built[0]
    assert backends["system"] is built[0]
