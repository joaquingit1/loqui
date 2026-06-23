# Transcription engine (PRD-2) — Foundation seams

Two **independent** real-time pipelines (one per source: `mic`="You",
`system`="They") that consume 16 kHz mono pcm_s16le from PRD-1's audio-ingest
hook and emit `TranscriptSegment` notifications (`partial` → `final`) over the
WS, which main forwards to the renderer.

This package ships the **contract seams** the four PRD-2 build units implement
against — not the pipeline logic.

## Seams (defined here, implemented by build units)

- `AsrBackend` (Protocol, `types.py`): injectable ASR. `name`, `load()`,
  `is_loaded`, `transcribe(pcm, sample_rate, language) -> list[AsrToken]`.
  - Default unit gate injects `FakeAsrBackend` (scripted, deterministic, **no
    model, no network**). The real faster-whisper/CTranslate2 backend is a build
    unit at `asr_backend.FasterWhisperBackend`, exercised only by the opt-in
    real-model smoke (`tests/test_asr_real_model.py`, gated on
    `LOQUI_RUN_ASR_TESTS`).
- `StreamingPolicy` (Protocol, `types.py`): LocalAgreement-2.
  `update(tokens) -> PolicyResult`, `flush()`, `reset()`. Pure-ish over a decode
  sequence — the trickiest correctness surface, unit-testable in isolation.
- `SegmentEmitter = Callable[[TranscriptSegment], None]` (`types.py`): the
  pipeline → outside-world callback. One call == one emitted segment.
- `TranscriptionPipeline` (Protocol, `manager.py`): per-`(meeting, source)`
  `feed(frame)` / `finish()`. Foundation ships `_NoopPipeline`.
- `TranscriptionManager` (`manager.py`): the `FrameConsumer` subscribed to
  `AudioIngest.add_consumer(...)`. Routes each decoded frame to its
  per-`(meeting, source)` pipeline; mic and system never share state.
- `make_ws_emitter(send)` (`manager.py`): adapts a raw `send(event, data)` WS
  sender into a `SegmentEmitter` that serializes to the exact camelCase wire
  shape (`meetingId`/`tStart`/`tEnd`/`segId`) the TS `transcriptSegmentSchema`
  validates, under `event = "transcriptSegment"` (`TRANSCRIPT_SEGMENT_EVENT`).

## Wiring (LIVE — integrated end-to-end)

`AppState.transcription` (a `TranscriptionManager`) is subscribed to
`AppState.audio` as a `FrameConsumer` in `AppState.__post_init__`. On WS connect,
`_install_transcript_emitter` wires the manager's emitter to the live socket
(thread-safe schedule onto the serving loop); it is cleared on disconnect.

`default_transcription_manager()` wires the **real** streaming pipeline
(`pipeline.make_pipeline_factory()` → `StreamingTranscriptionPipeline`: VAD
endpointing → `AsrBackend` → LocalAgreement-2) — the live path actually uses the
policy + the injectable ASR interface, no dead/bypassed code.

There is exactly **one** LocalAgreement-2 policy: `streaming.LocalAgreementPolicy`
(the exhaustively-tested one in `tests/test_streaming_policy.py`). `pipeline.py`
re-exports it as its default `policy_factory`, so the live/production path runs
the same robust policy the gate exercises — it strips the already-committed
prefix by matching committed text in order (so a real-backend decode that
inserts/shifts a leading word can never re-commit an already-committed token) and
normalizes case/trailing punctuation for agreement (so two decodes differing only
cosmetically still stabilize on agreement instead of waiting for the endpoint
flush).

The per-source ASR decode is **CPU-bound and may be slower than realtime**, so
`app.py` does not run it on the asyncio event loop: each binary audio frame (and
each `audioStart`/`audioStop`) is dispatched to a **per-source single-thread
executor** (`_dispatch_binary_frame`). This keeps the WS control channel
(ping/getHealth/shutdown) responsive during a decode and lets mic + system decode
on separate threads so a slow decode on one source never starves the other's
ingest (PRD-2 AC#3). The single-thread-per-source executor preserves frame order
and keeps `audioStop`'s flush ordered AFTER all that source's queued frames.

Backend selection is by the `LOQUI_FAKE_ASR` env flag:

- **unset (production):** the real `FasterWhisperBackend`, loaded lazily on a
  background daemon thread the first time a pipeline opens (`audioStart`) so the
  WS control channel is **never blocked** by the faster-whisper import / model
  download — audio buffers while the model loads, decodes start once it is ready.
- **set (`=1`):** the deterministic, source-aware streaming **FAKE** backend
  (`fake_stream.make_streaming_fake_backend`) — no model, no network, no
  inference. The unit gate (`tests/conftest.py` sets it), the hermetic smokes,
  and CI all use this so they stay fast + offline.

End-to-end smoke: `scripts/smoke-transcription.mjs` (root `smoke:transcription`,
in CI after `smoke:audio`) spawns the real sidecar with `LOQUI_FAKE_ASR=1`,
streams synthetic per-source marker PCM, and asserts `transcriptSegment`
notifications arrive partial-then-final with the correct per-source text, no
cross-wiring, one final `segId` per utterance, and a flush on `audioStop`.

## Config (`TranscriptionConfig`, `manager.py`)

`model_size` (default `small`), `device` (`cpu`), `compute_type` (`int8` on CPU,
`float16` on GPU), `language` (None = auto), `vad_aggressiveness`,
`max_parallelism` (2 = mic + system). CTranslate2 has **no Metal/MPS path** — on
Apple Silicon use `cpu` + `int8`.

## Measured latency / CPU (default model)

Orchestration overhead (pipeline only, measured): with the FAKE backend the
pipeline is **sub-millisecond per 20 ms frame**; the end-to-end transcription
smoke (both pipelines, ~2 s of speech each, interleaved) runs in well under a
second of wall time on an M-series laptop. The streaming budget the orchestration
imposes (independent of the backend): a `partial` can first appear one
`decode_interval_seconds` (default 0.5 s) after speech onset; a `final` lands at
the VAD endpoint (`EnergyVad.hangover_seconds`, default 0.6 s of trailing
silence) or on `audioStop`.

Real-backend (`FasterWhisperBackend`, `small` / `int8`, CPU) numbers still want a
measurement pass on target hardware — record, for 16 kHz mono with both pipelines
running:

> - real-time factor (RTF) per pipeline on an M-series CPU and a typical Windows CPU,
> - added end-to-end latency (speech → first `partial`, → stabilized `final`),
> - peak RSS,
> - the same numbers for the "lite" preset (`tiny`) for weak machines.

The real backend loads off the WS hot path (background daemon thread, see
*Wiring*), so the only user-visible cost of a cold first load is that early audio
buffers until the model is ready — it never stalls the control channel.

**Per-utterance decode cost.** The pipeline holds the whole current utterance and
re-decodes the entire growing buffer on each windowed decode (re-decoding the
committed prefix is what gives LocalAgreement-2 stable repeats, and keeps
committed-token timestamps correct without re-basing). So per-utterance backend
work grows with utterance length, bounded by `max_utterance_seconds` (30 s); the
policy exposes a `committed_seconds` watermark for a future front-trim
optimization, but the pipeline does not currently trim. Because decodes run on a
per-source worker thread (not the event loop), even the larger end-of-utterance
decodes never stall the control channel or the other source's ingest.
