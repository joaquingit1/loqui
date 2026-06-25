/**
 * Shared constants: protocol version + on-disk data-root layout.
 *
 * Everything here is consumed by both the Electron main process (TS) and,
 * indirectly via the emitted JSON Schema, by the Python sidecar.
 */

/**
 * The handshake / contract version. Bumped whenever the WS control envelope,
 * audio protocol, or event shapes change in a backward-incompatible way.
 * The sidecar prints this in its handshake line and the main process refuses
 * to connect on mismatch.
 */
export const PROTOCOL_VERSION = "0.1.0" as const;

/**
 * Environment variable that overrides the data root. MUST be honored by every
 * code path that resolves the data directory so that tests (and power users)
 * can point Loqui at a temp dir instead of the real ~/Loqui.
 */
export const DATA_DIR_ENV = "LOQUI_DATA_DIR" as const;

/**
 * Default data-root directory name, resolved under the user's home directory
 * when {@link DATA_DIR_ENV} is not set. i.e. `~/Loqui`.
 */
export const DEFAULT_DATA_DIR_NAME = "Loqui" as const;

/**
 * Subdirectory (relative to the data root) that holds one directory per
 * meeting: `<dataRoot>/meetings/<meetingId>/`.
 */
export const MEETINGS_DIR_NAME = "meetings" as const;

/**
 * SQLite index file name (relative to the data root): `<dataRoot>/index.db`.
 */
export const INDEX_DB_NAME = "index.db" as const;

/**
 * Per-meeting metadata file name: `<dataRoot>/meetings/<id>/meta.json`.
 */
export const MEETING_META_FILE = "meta.json" as const;

/**
 * Per-meeting structured transcript file name. Declared here so paths are
 * centralized. This is the parallel structured record (one JSONL line per
 * confirmed/`final` segment — `segId`/`tStart`/`tEnd`/`source`/`text`) the
 * main-process TranscriptWriter writes ALONGSIDE {@link MEETING_LIVE_TRANSCRIPT_FILE}
 * as part of the SAME append-only writer. PRD-5 diarization alignment reads it
 * (it needs per-segment timestamps + source); the human-facing source the user
 * watches update live is still {@link MEETING_LIVE_TRANSCRIPT_FILE}. Like the
 * `.md`, it is APPEND-ONLY and written by exactly one module — NOT an AI write.
 */
export const MEETING_TRANSCRIPT_FILE = "transcript.jsonl" as const;

/**
 * Per-meeting live transcript file name (PRD-3): `transcript.live.md`.
 *
 * This is the human-facing, append-only Markdown artifact that the
 * transcription path appends confirmed (`final`) segments to within ~1s of
 * confirmation. It is written by EXACTLY ONE module in the main process (the
 * TranscriptWriter) — no other code (and in particular no AI/chat code) may
 * write it. This is the structural enforcement of the cross-cutting
 * "AI never edits the transcript" invariant.
 */
export const MEETING_LIVE_TRANSCRIPT_FILE = "transcript.live.md" as const;

/**
 * The transcript variants a reader can request (see the store `getTranscript`
 * reader). `"live"` is {@link MEETING_LIVE_TRANSCRIPT_FILE} (the human-facing
 * Markdown); `"structured"` is {@link MEETING_TRANSCRIPT_FILE} (reserved JSONL).
 */
export const TRANSCRIPT_VARIANTS = ["live", "structured"] as const;

/**
 * Per-meeting summary file name (PRD-5). The structured AI summary
 * ({@link import("./postprocess.js").Summary}) the summary-writer produces from
 * the read-only transcript. A SEPARATE derived file — the provider never edits
 * the transcript.
 */
export const MEETING_SUMMARY_FILE = "summary.json" as const;

/**
 * Per-meeting DIARIZED transcript files (PRD-5): the speaker-labeled,
 * DERIVED re-labeling of the transcript (diarization + alignment, NOT AI).
 * `transcript.diarized.json` is the structured
 * {@link import("./postprocess.js").DiarizedTranscript}; `transcript.diarized.md`
 * is its human-facing Markdown render. Both are SEPARATE files — never the live
 * transcript ({@link MEETING_LIVE_TRANSCRIPT_FILE} stays byte-identical after
 * diarization). Written by the sidecar's diarized-transcript writer.
 */
export const MEETING_DIARIZED_TRANSCRIPT_JSON_FILE = "transcript.diarized.json" as const;
export const MEETING_DIARIZED_TRANSCRIPT_MD_FILE = "transcript.diarized.md" as const;

/**
 * Per-meeting HIGH-ACCURACY transcript files (PRD-2 two-tier transcription).
 * After a meeting ends, the sidecar re-transcribes the recorded `mic.wav` +
 * `system.wav` with a larger Whisper model (beam search, full-file language
 * detection) and writes these DERIVED files. `transcript.hifi.md` mirrors the
 * live `.md` line format (`[hh:mm:ss] You/They said: …`) and
 * `transcript.hifi.jsonl` mirrors {@link MEETING_TRANSCRIPT_FILE}. They are a
 * BETTER re-transcription of the same audio — NOT an AI edit. The live files
 * ({@link MEETING_LIVE_TRANSCRIPT_FILE} / {@link MEETING_TRANSCRIPT_FILE}) stay
 * byte-identical; the store's `getTranscript` PREFERS these when present, and
 * diarization aligns to `transcript.hifi.jsonl` over the live JSONL.
 */
export const MEETING_HIFI_TRANSCRIPT_MD_FILE = "transcript.hifi.md" as const;
export const MEETING_HIFI_TRANSCRIPT_JSONL_FILE = "transcript.hifi.jsonl" as const;

/**
 * Per-meeting raw audio subdirectory: `<meetingDir>/audio/`.
 */
export const MEETING_AUDIO_DIR_NAME = "audio" as const;

/**
 * The two audio sources. Mic is "You"; system loopback is "They". They are
 * kept independent end-to-end and only correlated by timestamp.
 */
export const AUDIO_SOURCES = ["mic", "system"] as const;

/** Canonical capture format used across the audio protocol. */
export const AUDIO_SAMPLE_RATE = 16000 as const;
export const AUDIO_CHANNELS = 1 as const;
export const AUDIO_ENCODING = "pcm_s16le" as const;

/**
 * Per-source raw-audio WAV filenames written inside `<meetingDir>/audio/`.
 * The sidecar ingest unit ("sidecar-audio-ingest") writes exactly these two
 * files (16 kHz mono pcm_s16le WAV), one per {@link AUDIO_SOURCES} value:
 *   <dataRoot>/meetings/<id>/audio/mic.wav
 *   <dataRoot>/meetings/<id>/audio/system.wav
 */
export const AUDIO_WAV_FILENAME = {
  mic: "mic.wav",
  system: "system.wav",
} as const;

/**
 * Default DSP frame duration in milliseconds. The AudioWorklet (packages/audio)
 * accumulates this many ms of 16 kHz mono samples per binary frame before
 * posting it. 20 ms @ 16 kHz = 320 samples = 640 PCM bytes + 16-byte header.
 * Keep configurable; this is only the default.
 */
export const AUDIO_FRAME_DURATION_MS = 20 as const;

/**
 * Default number of 16 kHz mono samples per DSP frame, derived from
 * {@link AUDIO_FRAME_DURATION_MS}. 20 ms * 16000 / 1000 = 320 samples.
 */
export const AUDIO_FRAME_SAMPLES =
  (AUDIO_SAMPLE_RATE * AUDIO_FRAME_DURATION_MS) / 1000;
