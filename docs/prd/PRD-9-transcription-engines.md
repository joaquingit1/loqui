# PRD-9 — Pluggable Transcription Engines (incl. Apple-native on-device)

## Goal
Make the transcription engine **user-selectable**, and add **macOS-native on-device engines** alongside the cross-platform default — matching and exceeding a comparable local app's engine choice (Parakeet-TDT, WhisperKit Base/Large, Apple Speech). faster-whisper stays the default and the only cross-platform option; on Apple Silicon, offer faster ANE-accelerated and zero-download engines.

## Background (competitive)
a comparable local app offers four selectable transcription models, including **Apple Speech** (zero download, on-device) and **WhisperKit** (CoreML/ANE, much faster than CPU faster-whisper on Apple Silicon). Loqui currently ships only faster-whisper (CPU on Mac — no Metal path in CTranslate2). This PRD closes the engine-choice and Apple-Silicon-speed gaps. The PRD-2 ASR backend is already an injectable interface (`AsrBackend`) — this PRD turns that seam into a real multi-engine selector + adds the native engines.

## Scope / deliverables
- **Engine selection** in Settings: faster-whisper (default, cross-platform) · **Apple Speech** (macOS) · **WhisperKit / MLX Whisper** (macOS, ANE) · (stretch) **NVIDIA Parakeet** where a GPU/ANE path is viable. Per-engine model-size + language options. Selection takes effect for the next meeting; engines run through the existing per-source streaming pipeline.
- **macOS Swift helper** (`apps/desktop/native/macos/` or a `mac-helper/` crate): a small notarizable Swift binary the sidecar invokes over a simple line/JSON protocol, exposing:
  - **Apple Speech** transcription (`SFSpeechRecognizer`, on-device `requiresOnDeviceRecognition = true`) — streaming partial+final results from a 16 kHz mono PCM stream. Handles the Speech Recognition permission.
  - **WhisperKit / MLX-Whisper** transcription (ANE-accelerated). (May ship as a second helper or a WhisperKit-backed path.)
  - Graceful capability probe: the helper reports which engines are available on this OS/arch.
- **`AsrBackend` implementations** for the native engines, plumbed through the PRD-2 streaming wrapper (VAD + LocalAgreement still apply to faster-whisper; native engines that stream their own partials bypass the windowing as appropriate). Engine abstraction keeps the two-stream (You/They) model intact.
- **Cross-platform fallback**: on Windows (or when a native engine is unavailable), the selector falls back to faster-whisper with a clear note. No engine choice ever breaks the meeting.
- Settings UI: engine + model + language, with download/availability/permission status; "show models in Finder"–style affordances.

## Out of scope
Summary models (PRD-10). Packaging/signing of the helper (PRD-8 wires the helper into the bundle/notarization).

## Acceptance criteria
1. A user can switch transcription engine in Settings; the next meeting transcribes with the chosen engine; the two-stream You/They model and the real-time live transcript still work.
2. On macOS, **Apple Speech** transcribes with **zero model download** (after granting Speech Recognition permission) and runs fully on-device.
3. On Apple Silicon, the **WhisperKit/MLX** path is measurably faster than CPU faster-whisper on the same audio (document the numbers).
4. On Windows / when a native engine is unavailable, the app falls back to faster-whisper without error.
5. Hermetic tests: the engine selector + `AsrBackend` conformance with a fake/native-stub backend; the Swift helper's protocol parsed correctly (mock the helper process). A best-effort opt-in real test runs Apple Speech on `say`-generated audio (macOS only, skipped elsewhere).
6. PRD-0..8 stay green.

## Notes for implementers
- The Swift helper mirrors the established native-helper pattern (a notarizable binary the Python sidecar spawns and streams PCM to). Keep the engine interface identical to PRD-2's `AsrBackend` so the pipeline is engine-agnostic.
- Apple Speech `SFSpeechRecognizer` on-device has its own segmentation; adapt its partial/final events to `TranscriptSegment` rather than forcing LocalAgreement on top.
- macOS-only engines are gracefully absent on Windows — the selector must hide/disable them and never crash.
