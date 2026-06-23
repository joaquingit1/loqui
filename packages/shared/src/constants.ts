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
 * Per-meeting transcript file name (written ONLY by the transcription engine
 * in a later PRD; declared here so paths are centralized).
 */
export const MEETING_TRANSCRIPT_FILE = "transcript.jsonl" as const;

/**
 * Per-meeting summary file name (written by the summaries PRD).
 */
export const MEETING_SUMMARY_FILE = "summary.json" as const;

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
