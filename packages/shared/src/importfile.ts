/**
 * PRD-12 — File Import wire contract (main → sidecar → main).
 *
 * "Transcribe a file" decodes an existing audio/video file to the SAME 16 kHz
 * mono PCM the live capture path produces, runs it through the EXISTING
 * transcription engine, writes the SAME transcript files a live meeting writes
 * (`transcript.live.md` + `transcript.jsonl`) plus a `system.wav` (so the
 * existing diarization can read it), then runs the EXISTING diarization +
 * summary. It is a SINGLE-stream source (no separate You/They) → every speaker
 * is diarized as Speaker 1/2/… (the import writes the decoded audio as the
 * `system` stream, so the existing alignment labels it `Speaker N`).
 *
 * Progress is reported via the EXISTING {@link JobUpdate} events (`kind`
 * `"transcription"` for the decode/ASR pass, then `"diarization"`/`"summary"`
 * from the reused post-process pipeline). When the whole import finishes the
 * sidecar emits one terminal {@link ImportFileDone} so main can finalize the
 * meeting (status → `done`, index the searchable text).
 *
 * These shapes are defined here (emitted to JSON Schema) so the Python sidecar
 * validates the inbound `importFile` notification against the SAME contract.
 */
import { z } from "zod";
import { providerConfigSchema } from "./chat.js";
import { diarizationBackendPreferenceSchema, postProcessStageSchema } from "./postprocess.js";

/** Notification `event` names for the file-import flow. */
export const IMPORT_FILE_EVENT = "importFile" as const;
export const IMPORT_FILE_DONE_EVENT = "importFileDone" as const;

/**
 * Common importable container/codec extensions (lower-case, no dot). Used by the
 * renderer's open-file dialog filter and as documentation of the accepted set —
 * the sidecar relies on PyAV/ffmpeg to actually decode, so this list is
 * advisory, not a hard gate.
 */
export const IMPORT_FILE_EXTENSIONS = [
  "m4a",
  "mp3",
  "wav",
  "aac",
  "flac",
  "ogg",
  "opus",
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
] as const;

/**
 * The inbound `importFile` notification payload (main → sidecar). `meetingId` is
 * a meeting main has ALREADY created (`kind:"import"`, status `"processing"`);
 * `filePath` is the absolute path to the source media file. `providerConfig` +
 * the optional secrets mirror {@link PostProcessRequest} so the reused
 * post-process step (diarization + summary) runs with the user's configured
 * provider/keys (transient — never persisted, never logged).
 */
export const importFileRequestSchema = z.object({
  meetingId: z.string(),
  filePath: z.string().min(1),
  providerConfig: providerConfigSchema.default({}),
  apiKey: z.string().nullable().default(null).optional(),
  hfToken: z.string().nullable().default(null).optional(),
  diarizationBackend: diarizationBackendPreferenceSchema.default("auto"),
});
export type ImportFileRequest = z.infer<typeof importFileRequestSchema>;

/**
 * Terminal `importFileDone` event (sidecar → main): the import finished
 * (transcription + diarization + summary). Mirrors the relevant
 * {@link PostProcessDone} fields so main can finalize the meeting + index the
 * searchable text uniformly with a normal meeting. `transcription` reports the
 * decode/ASR stage outcome; `ok` is false only when the file could not be
 * decoded at all (no transcript produced).
 */
export const importFileDoneSchema = z.object({
  meetingId: z.string(),
  ok: z.boolean().default(true),
  transcription: postProcessStageSchema.default("skipped"),
  diarization: postProcessStageSchema.default("skipped"),
  summary: postProcessStageSchema.default("skipped"),
  speakers: z.array(z.string()).default([]),
  diarizationBackend: z.string().default(""),
  summaryProvider: z.string().default(""),
  summaryModel: z.string().default(""),
  indexText: z.string().default(""),
  note: z.string().default(""),
});
export type ImportFileDone = z.infer<typeof importFileDoneSchema>;

/**
 * Params for the `importFile` renderer IPC channel (renderer → main). The
 * renderer picks a file (open dialog / drop target) and hands main the absolute
 * path + an optional title; main mints the `kind:"import"` meeting and drives
 * the sidecar. Returns the created {@link import("./meeting.js").Meeting}.
 */
export const importFileParamsSchema = z.object({
  filePath: z.string().min(1),
  title: z.string().optional(),
});
export type ImportFileParams = z.infer<typeof importFileParamsSchema>;
