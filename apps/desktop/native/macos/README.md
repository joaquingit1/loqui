# loqui-asr-helper — macOS-native on-device ASR + summary helper (PRD-9, PRD-10)

A small, notarizable Swift command-line binary the Python sidecar spawns to run
**macOS-native on-device transcription engines** alongside the cross-platform
faster-whisper default — and (PRD-10) **macOS-native on-device summary engines**
(Apple Foundation Models / NaturalLanguage / bundled MLX) so summaries + chat can
run with zero API key and zero cloud. The summary protocol is documented below
under "Summary protocol (PRD-10)"; the Python side is
`sidecar/loqui_sidecar/providers/native_provider.py`.

The transcription engines, alongside the cross-platform faster-whisper default:

- **Apple Speech** — `SFSpeechRecognizer` with `requiresOnDeviceRecognition =
  true`. Zero model download (after the one-time Speech Recognition permission),
  fully on-device.
- **WhisperKit / MLX-Whisper** — an ANE-accelerated Whisper path (optional,
  gated behind the `-DWHISPERKIT` build flag), measurably faster than CPU
  faster-whisper on Apple Silicon.
- **Capability probe** — reports which engines are available on this OS/arch so
  the sidecar (and the Settings UI) can hide/disable unavailable engines and fall
  back gracefully.

The host (the Python sidecar) owns the audio windowing and the LocalAgreement-2
streaming policy; this helper is a passive, host-driven recognizer. See
`sidecar/loqui_sidecar/transcription/native_backend.py` for the Python side.

## Build (macOS only)

```sh
./build.sh                # Apple Speech only (default)
./build.sh --whisperkit   # also build the WhisperKit/MLX ANE path
```

Output: `.build/release/loqui-asr-helper`. Point the sidecar at it:

```sh
export LOQUI_ASR_HELPER_BIN="$PWD/.build/release/loqui-asr-helper"
```

PRD-8 packaging bundles + notarizes this binary into the app and sets
`LOQUI_ASR_HELPER_BIN` to the bundled path. On Windows the binary is absent, so
the sidecar's capability probe returns no native engines and the selector falls
back to faster-whisper — no engine choice ever breaks a meeting.

## Line/JSON protocol

One JSON object per line (`\n`-terminated, UTF-8) in each direction over the
helper's stdin (host → helper) and stdout (helper → host). PCM rides
base64-encoded inside a `decode` request so the channel is a single line stream.
All token timestamps are **buffer-relative seconds** (the host shifts them onto
the meeting timeline). This is the exact contract the Python
`NativeHelperBackend` speaks — keep both sides in sync.

### Host → helper

| line | meaning |
| --- | --- |
| `{"type":"probe"}` | ask which engines are available; helper replies `capabilities`. |
| `{"type":"start","engine":"apple-speech"\|"whisperkit"\|"mlx-whisper"\|"parakeet","modelSize":"tiny"\|...\|null,"language":"en"\|null,"sampleRate":16000}` | begin a session for one source with the chosen engine. |
| `{"type":"decode","pcmBase64":"<base64 pcm_s16le>"}` | decode this window; helper replies with one `tokens` line. |
| `{"type":"stop"}` | end the session (flush + release the recognizer). |

### Helper → host

| line | meaning |
| --- | --- |
| `{"type":"ready","engine":"...","version":"..."}` | sent after a successful `start`. |
| `{"type":"capabilities","engines":[...],"os":"darwin","arch":"arm64"}` | reply to `probe`. |
| `{"type":"tokens","tokens":[{"text":"hi","tStart":0.0,"tEnd":0.3}],"final":false}` | the decode result (one per `decode`). `final` flags an Apple-Speech final result (advisory — the host's endpointing owns commit timing). |
| `{"type":"error","code":"...","message":"..."}` | a recoverable error (e.g. permission denied). The host degrades the affected decode to "no tokens" and, on `start`, falls back to faster-whisper. |

The host reads lines until it sees the reply matching its request
(`capabilities` for `probe`, `tokens` for `decode`), tolerating and logging any
unrecognized line (forward-compatible).

## Summary protocol (PRD-10)

Additive to the ASR protocol on the SAME stdin/stdout channel (parsed by `type`).
The host (`native_provider.py`) drives it request/response — there is no token
stream; the helper returns the whole result in one `summaryResult`. The engines:

- **apple-foundation** — Apple Foundation Models (the on-device Apple-Intelligence
  LLM, macOS 26 + Apple Intelligence enabled; gated behind `-DFOUNDATION_MODELS`).
  Preferred generative target; degrades to **apple-nl** when unavailable.
- **apple-nl** — Apple NaturalLanguage extractive highlights (always available on
  macOS 13+; zero download, zero key, no LLM).
- **mlx** — a bundled small instruct model (Qwen/Gemma-class) via MLX on Apple
  Silicon (gated behind `-DMLX_SUMMARY`); fetched on first use, then offline.

### Host → helper

| line | meaning |
| --- | --- |
| `{"type":"summaryProbe"}` | ask which summary engines are available; helper replies `summaryCapabilities`. |
| `{"type":"summaryStart","engine":"apple-foundation"\|"apple-nl"\|"mlx","model":"<id>"\|null}` | begin a summary session (loads/fetches the model for `mlx`). |
| `{"type":"summaryGenerate","prompt":"<full prompt incl. transcript>"}` | generate; helper replies with one `summaryResult`. |
| `{"type":"summaryStop"}` | end the session (release the model). |

### Helper → host

| line | meaning |
| --- | --- |
| `{"type":"summaryCapabilities","engines":[...],"os":"darwin","arch":"arm64"}` | reply to `summaryProbe`. |
| `{"type":"summaryReady","engine":"...","model":"..."}` | sent after a successful `summaryStart`. |
| `{"type":"summaryResult","text":"..."}` | the generated/extracted summary text (one per `summaryGenerate`). |
| `{"type":"error","code":"...","message":"..."}` | a recoverable error (model unavailable, permission, fetch failed). The host maps it to a stable `ChatProviderError` and falls back to Ollama / BYOK / cloud. |

READ-ONLY: a summary engine receives only the prompt text (the host splices in the
read-only transcript) and returns text — it never touches any transcript/meta
file, so "the AI never edits the transcript" holds for the native path too.

## Engine ↔ pipeline mapping

- **WhisperKit / MLX** decode a window like Whisper, so the host's VAD +
  LocalAgreement-2 windowing applies unchanged.
- **Apple Speech** has its own segmentation; its helper returns the latest
  hypothesis per window and the host's flush commits the final, rather than
  forcing LocalAgreement on top.

Both reduce to the same `decode → tokens` seam, so the host pipeline is
engine-agnostic and the two-stream (You/They) model is untouched — each
`(meeting, source)` pipeline owns its own helper process.

## Verification status

- **Verified hermetically on any host (incl. Windows):** the protocol parsing,
  the token mapping, the selector, and the fallback — via a Python *fake helper*
  in `sidecar/tests/test_transcription_engines.py` (ASR) and
  `sidecar/tests/_summary_helpers.py` + `test_native_provider.py` /
  `test_summary_templates.py` (PRD-10 summary; no Swift, no model).
- **Mac/CI-only:** the real Swift compile (`./build.sh`) and the real Apple
  Speech / WhisperKit run — exercised by the opt-in
  `sidecar/tests/test_apple_speech_real.py`; and the real Apple Foundation Models
  / NaturalLanguage / MLX summary run via the opt-in
  `sidecar/tests/test_native_summary_real.py` (skipped unless macOS +
  `LOQUI_RUN_NATIVE_SUMMARY=1` + the built helper).
