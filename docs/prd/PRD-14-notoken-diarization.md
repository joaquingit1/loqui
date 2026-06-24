# PRD-14 — No-Token Local Diarization (sherpa-onnx default)

## Goal
Make speaker diarization work **100% locally with no Hugging Face token and no account** out of the box, by adding a non-gated `sherpa-onnx` ONNX backend as the **default** diarizer. Keep pyannote (HF-token, higher accuracy) as an **opt-in upgrade**. This removes the only mandatory token in the entire product.

## Background
PRD-5 shipped diarization behind an injectable `DiarizationBackend` (`FakeDiarizer` + `PyannoteDiarizer`). pyannote's `speaker-diarization-3.1` / `community-1` weights are **gated** on Hugging Face — they require an account + token + accepting terms to download (inference is offline afterward). That's the only token/account dependency in Loqui (transcription, search, MCP, Ollama/Apple-native summaries, and auto-update are all token-free). This PRD eliminates it.

`sherpa-onnx` (k2-fsa) provides **Apache-2.0** ONNX diarization models — a pyannote-style segmentation model (~6 MB) + a speaker-embedding model (3D-Speaker CAM++ / WeSpeaker, ~15 MB) — downloadable from **sherpa-onnx's own GitHub releases with no HF token/account**, redistributable (so we can bundle them), CPU-only, cross-platform (macOS + Windows), with automatic speaker clustering (no need to know the speaker count). DER is modestly higher than pyannote (~13–16% vs ~11%) but more than adequate for meeting notes.

## Scope / deliverables
- **`SherpaOnnxDiarizer`** implementing the PRD-5 `DiarizationBackend` protocol (`diarize(wav_path) -> list[SpeakerTurn]`), via the `sherpa-onnx` Python package + the segmentation + embedding ONNX models. Auto-clusters speakers. Runs on the existing `system.wav` post-process path; feeds the same `align()` function.
- **Bundle / first-run-fetch the ONNX models** from a non-gated source (sherpa-onnx GitHub releases, or mirrored on Loqui's own GitHub release) — no HF token, no account. (Apache-2.0 permits bundling.) Wire into PRD-8 packaging.
- **Make sherpa-onnx the DEFAULT** diarization backend. Demote `PyannoteDiarizer` to an opt-in "max accuracy (requires a free Hugging Face token)" choice in Settings; if a HF token is present, prefer `community-1`, else fall back to sherpa-onnx. Backend selectable in Settings with a clear accuracy/footprint note.
- **Dependency**: `sherpa-onnx` (Apache-2.0, lightweight, no torch) — add to the base sidecar env (it's small and CPU-only), unlike torch/pyannote which stay an optional group. Confirm the base install stays lean and cross-platform.
- Update PRD-5's pyannote-degradation messaging: with no HF token, diarization no longer "skips" — it uses the no-token sherpa-onnx default and still produces a diarized transcript.
- **Optional zero-network note**: document (and optionally implement) bundling the default faster-whisper model so a fresh install needs no network at all (ties to PRD-9 Apple Speech, which is zero-download on macOS).

## Out of scope
The pyannote backend itself (exists from PRD-5). Transcription engines (PRD-9). Summaries (PRD-10).

## Acceptance criteria
1. On a fresh install with **no HF token and no account**, a finished meeting is diarized (≥2 system speakers + "You") using the sherpa-onnx default — fully offline after the bundled/one-time model fetch.
2. The diarizer is selectable; providing a HF token switches to pyannote `community-1` (higher accuracy); absent a token, sherpa-onnx is used (no "skipped").
3. Cross-platform: works on macOS + Windows, CPU-only; the base sidecar env stays lean (no torch required for the default path).
4. Reuses the PRD-5 `align()` + diarized-file writer + indexing; the transcript invariant (live transcript byte-identical) still holds.
5. Hermetic tests: `SherpaOnnxDiarizer` behind the backend protocol with the ONNX model mocked/stubbed for the unit gate; a best-effort opt-in real test runs the actual ONNX models on a fixture WAV (models fetched/cached). `smoke:postprocess` continues to pass with the new default.
6. PRD-0..5 stay green.

## Notes for implementers
- `sherpa_onnx.OfflineSpeakerDiarization(segmentation_model=..., speaker_embedding_model=...)` → `.diarize(wav)` returns labeled segments; map to `SpeakerTurn`. No HF calls anywhere.
- Bundling ~21 MB of ONNX is cheap vs torch/pyannote (GBs) — this is also a packaging win for PRD-8.
- Keep pyannote strictly optional (the heavy `[dependency-groups] diarization` group) — the default no-token path must not pull torch.
