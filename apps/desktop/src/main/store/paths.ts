/**
 * Data-root path resolution. The ONLY place that decides where Loqui's data
 * lives. Honors the LOQUI_DATA_DIR env var so tests stay hermetic and never
 * touch the real ~/Loqui.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIR_ENV,
  DEFAULT_DATA_DIR_NAME,
  INDEX_DB_NAME,
  MEETINGS_DIR_NAME,
  MEETING_AUDIO_DIR_NAME,
  MEETING_DIARIZED_TRANSCRIPT_JSON_FILE,
  MEETING_DIARIZED_TRANSCRIPT_MD_FILE,
  MEETING_LIVE_TRANSCRIPT_FILE,
  MEETING_META_FILE,
  MEETING_SUMMARY_FILE,
  MEETING_TRANSCRIPT_FILE,
  type TranscriptVariant,
} from "@loqui/shared";

/** Absolute path to the data root. Override via LOQUI_DATA_DIR. */
export function dataRoot(): string {
  const override = process.env[DATA_DIR_ENV];
  if (override && override.trim() !== "") return override;
  return join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/** `<dataRoot>/meetings` */
export function meetingsDir(): string {
  return join(dataRoot(), MEETINGS_DIR_NAME);
}

/** `<dataRoot>/index.db` */
export function indexDbPath(): string {
  return join(dataRoot(), INDEX_DB_NAME);
}

/** `<dataRoot>/meetings/<id>` */
export function meetingDir(id: string): string {
  return join(meetingsDir(), id);
}

/** `<dataRoot>/meetings/<id>/meta.json` */
export function meetingMetaPath(id: string): string {
  return join(meetingDir(id), MEETING_META_FILE);
}

/** `<dataRoot>/meetings/<id>/audio` */
export function meetingAudioDir(id: string): string {
  return join(meetingDir(id), MEETING_AUDIO_DIR_NAME);
}

/** `<dataRoot>/meetings/<id>/transcript.live.md` — the human-facing transcript. */
export function meetingLiveTranscriptPath(id: string): string {
  return join(meetingDir(id), MEETING_LIVE_TRANSCRIPT_FILE);
}

/** Absolute path to a meeting's transcript file for the requested variant. */
export function meetingTranscriptPath(id: string, variant: TranscriptVariant): string {
  const file =
    variant === "structured" ? MEETING_TRANSCRIPT_FILE : MEETING_LIVE_TRANSCRIPT_FILE;
  return join(meetingDir(id), file);
}

/** `<dataRoot>/meetings/<id>/summary.json` — the AI summary (PRD-5). */
export function meetingSummaryPath(id: string): string {
  return join(meetingDir(id), MEETING_SUMMARY_FILE);
}

/** `<dataRoot>/meetings/<id>/transcript.diarized.json` — structured diarized transcript (PRD-5). */
export function meetingDiarizedTranscriptJsonPath(id: string): string {
  return join(meetingDir(id), MEETING_DIARIZED_TRANSCRIPT_JSON_FILE);
}

/** `<dataRoot>/meetings/<id>/transcript.diarized.md` — human-facing diarized transcript (PRD-5). */
export function meetingDiarizedTranscriptMdPath(id: string): string {
  return join(meetingDir(id), MEETING_DIARIZED_TRANSCRIPT_MD_FILE);
}
