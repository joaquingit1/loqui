# Third-party licenses

Loqui's sidecar incorporates adapted source from the following projects.

## WhisperLive

`loqui_sidecar/transcription/whisperlive_core.py` is a faithful, trimmed port of
the streaming transcription algorithm from **WhisperLive**
(https://github.com/collabora/WhisperLive, pinned to **v0.9.0** —
`whisper_live/backend/base.py` + `whisper_live/backend/faster_whisper_backend.py`).
Loqui's adaptations: removed the torch CUDA probe + torch Silero VAD (Loqui runs
CPU/int8 and uses faster-whisper's built-in `vad_filter`), translation, speaker
diarization, word timestamps, the batch worker, metrics, and the WebSocket
transport (replaced by an injected `on_result` callback + an injected
faster-whisper model). The streaming buffer management and segment-commit logic
are preserved.

```
MIT License

Copyright (c) 2023 Vineet Suryan, Collabora Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
