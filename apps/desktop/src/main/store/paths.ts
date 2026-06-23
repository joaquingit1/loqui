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
  MEETING_META_FILE,
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
