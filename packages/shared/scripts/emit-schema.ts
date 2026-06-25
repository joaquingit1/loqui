/**
 * Emits JSON Schema files (one per contract schema) into packages/shared/schema/
 * so the Python sidecar can validate incoming frames against the SAME contract
 * the TypeScript side uses. Run as part of `pnpm --filter @loqui/shared build`.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

import {
  handshakeSchema,
  healthSchema,
  wsRequestSchema,
  wsResponseSchema,
  wsErrorSchema,
  wsNotificationSchema,
  wsEnvelopeSchema,
  pingResultSchema,
  shutdownResultSchema,
} from "../src/protocol.js";
import {
  meetingSchema,
  participantSchema,
  createMeetingInputSchema,
  updateMeetingInputSchema,
} from "../src/meeting.js";
import { audioStartSchema, audioStopSchema } from "../src/audio.js";
import { transcriptSegmentSchema, jobUpdateSchema } from "../src/events.js";
import {
  chatMessageSchema,
  providerConfigSchema,
  chatRequestSchema,
  chatTokenSchema,
  chatDoneSchema,
  chatErrorSchema,
} from "../src/chat.js";
import {
  speakerTurnSchema,
  diarizedSegmentSchema,
  diarizedTranscriptSchema,
  actionItemSchema,
  summarySchema,
  postProcessRequestSchema,
  postProcessDoneSchema,
} from "../src/postprocess.js";
import {
  speakerActivityEventSchema,
  extensionMessageSchema,
  speakerCorrelationParamsSchema,
  speakerNameResolutionSchema,
  speakerCorrelationResultSchema,
  speakerNamesStatusSchema,
} from "../src/speakernames.js";
import { importFileRequestSchema, importFileDoneSchema } from "../src/importfile.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "schema");

const schemas: Record<string, ZodTypeAny> = {
  Handshake: handshakeSchema,
  Health: healthSchema,
  WsRequest: wsRequestSchema,
  WsResponse: wsResponseSchema,
  WsError: wsErrorSchema,
  WsNotification: wsNotificationSchema,
  WsEnvelope: wsEnvelopeSchema,
  PingResult: pingResultSchema,
  ShutdownResult: shutdownResultSchema,
  Meeting: meetingSchema,
  Participant: participantSchema,
  CreateMeetingInput: createMeetingInputSchema,
  UpdateMeetingInput: updateMeetingInputSchema,
  AudioStart: audioStartSchema,
  AudioStop: audioStopSchema,
  TranscriptSegment: transcriptSegmentSchema,
  JobUpdate: jobUpdateSchema,
  // PRD-4 chat contract (sidecar validates the inbound `chatRequest` notification
  // against ChatRequest; the rest are emitted so the contract is fully visible).
  ChatMessage: chatMessageSchema,
  ProviderConfig: providerConfigSchema,
  ChatRequest: chatRequestSchema,
  ChatToken: chatTokenSchema,
  ChatDone: chatDoneSchema,
  ChatError: chatErrorSchema,
  // PRD-5 post-processing contract. The sidecar validates the inbound
  // `postProcess` notification against PostProcessRequest; the rest are emitted
  // so the diarization/summary/index contract is fully visible to Python.
  SpeakerTurn: speakerTurnSchema,
  DiarizedSegment: diarizedSegmentSchema,
  DiarizedTranscript: diarizedTranscriptSchema,
  ActionItem: actionItemSchema,
  Summary: summarySchema,
  PostProcessRequest: postProcessRequestSchema,
  PostProcessDone: postProcessDoneSchema,
  // PRD-6 Google-Meet speaker-name attribution. Emitted so the (TS-only)
  // extension <-> main wire + the pure correlation contract are fully visible.
  // The Python sidecar is NOT involved in PRD-6; these are for documentation +
  // cross-process TS parity, mirroring the other emitted contracts.
  SpeakerActivityEvent: speakerActivityEventSchema,
  ExtensionMessage: extensionMessageSchema,
  SpeakerCorrelationParams: speakerCorrelationParamsSchema,
  SpeakerNameResolution: speakerNameResolutionSchema,
  SpeakerCorrelationResult: speakerCorrelationResultSchema,
  SpeakerNamesStatus: speakerNamesStatusSchema,
  // PRD-12 file import. The sidecar validates the inbound `importFile`
  // notification against ImportFileRequest; ImportFileDone is emitted so the
  // terminal import contract is fully visible to Python.
  ImportFileRequest: importFileRequestSchema,
  ImportFileDone: importFileDoneSchema,
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(schemas)) {
  const json = zodToJsonSchema(schema, { name, target: "jsonSchema7" });
  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify(json, null, 2) + "\n",
    "utf8",
  );
}

console.log(
  `[emit-schema] wrote ${Object.keys(schemas).length} schema(s) to ${outDir}`,
);
