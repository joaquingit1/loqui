# PRD-1 — Dual-Stream Audio Capture

## Goal
Capture the **microphone** ("You") and **system/loopback audio** ("They") as two **independent, simultaneous** streams, downmix/resample each to **16 kHz mono PCM**, and deliver them to the Python sidecar tagged by source. Also persist the raw streams for post-meeting diarization.

## Background
This is the hardest part of the product and the input to everything downstream. The two streams must never be mixed. We use Electron's built-in cross-platform loopback for the MVP (no native modules), with a clear path to a native Core Audio taps helper later.

## Scope / deliverables

### Capture (renderer + main)
- **Microphone**: `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation, noiseSuppression, channelCount } })`.
- **System audio**: main process registers
  `session.defaultSession.setDisplayMediaRequestHandler(handler, { audio: 'loopback' })`,
  renderer obtains the stream via `navigator.mediaDevices.getDisplayMedia({ audio: true, video: ... })` and keeps only the audio track. (Loopback is ScreenCaptureKit-backed on macOS 13+, WASAPI on Windows.)
- Both run concurrently and are kept as separate `MediaStream`s.

### DSP (`packages/audio`)
- An **AudioWorklet** that, per stream: downmixes to mono, resamples to 16 kHz, converts to `pcm_s16le`, and posts fixed-size frames (e.g. 20–32 ms).
- Shared, well-tested resample/downmix utilities (unit-tested with synthetic buffers).

### Transport to sidecar
- Open the `audioStart` control frame (from PRD-0 contract) per source, stream binary PCM frames, close with `audioStop`. Backpressure-aware (drop/queue policy documented).

### Raw persistence
- Tee each stream to `~/Loqui/meetings/<id>/audio/mic.wav` and `audio/system.wav` (16 kHz mono WAV), needed for re-diarization. Written incrementally; finalized on stop.

### Permissions & UX
- **macOS**: first system-audio capture triggers the **Screen Recording** permission prompt. Provide onboarding UI explaining why, detect denial, deep-link to System Settings, and handle the "needs restart after grant" case.
- **Windows**: no special permission; handle absent/!default render device.
- **Device selection** UI (input device + which output to loop back), **live level meters** for both streams, and graceful **start/stop** with resource cleanup.

## Out of scope
Transcription (PRD-2). Native Core Audio taps helper (post-MVP) — but keep the capture interface swappable.

## Acceptance criteria
1. On a real **Mac** and **Windows** machine, starting a meeting while audio plays *and* the user speaks yields two distinct PCM streams arriving at the sidecar, correctly tagged `mic` vs `system`.
2. `mic.wav` and `system.wav` are written, are 16 kHz mono, and on playback contain the expected, **separated** audio (mic ≈ only the user; system ≈ only the other side).
3. Level meters move independently for each stream.
4. Denying macOS screen-recording permission shows a clear recovery path, not a crash.
5. Start → stop → start again works without leaking audio nodes or file handles.
6. `packages/audio` resample/downmix unit tests pass (correct output rate, length, mono mixing).

## Notes for implementers
- Electron `getDisplayMedia` audio loopback requires the main-process `setDisplayMediaRequestHandler` with `{ audio: 'loopback' }`; on macOS this still routes through screen-recording permission.
- Keep frame size and ring-buffer sizing configurable; document the chosen defaults and the drop policy under load.
- Resampling 48 kHz→16 kHz: use a proper low-pass/resampler (not naive decimation) to avoid aliasing.
