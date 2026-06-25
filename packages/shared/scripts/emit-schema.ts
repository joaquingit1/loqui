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
import { audioStartSchema, audioStopSchema, audioFinalizedSchema } from "../src/audio.js";
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
import {
  autoRecordSettingsSchema,
  updateAutoRecordSettingsSchema,
  detectionInputsSchema,
  detectionDecisionSchema,
  autoRecordStateSchema,
  browserCallStateSchema,
} from "../src/autorecord.js";
import { importFileRequestSchema, importFileDoneSchema } from "../src/importfile.js";
import {
  exportFormatSchema,
  exportMeetingParamsSchema,
  exportResultSchema,
} from "../src/export.js";
import {
  captureSettingsSchema,
  updateCaptureSettingsSchema,
  captureCapabilitySchema,
} from "../src/privacy.js";
import {
  updateAssetSchema,
  updateManifestSchema,
  updaterSettingsSchema,
  updateUpdaterSettingsSchema,
  updaterStateSchema,
} from "../src/updater.js";
import {
  transcriptionSettingsSchema,
  updateTranscriptionSettingsSchema,
  transcriptionEngineInfoSchema,
  transcriptionStatusSchema,
} from "../src/transcription.js";

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
  AudioFinalized: audioFinalizedSchema,
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
  // PRD-11 auto-record + menubar/tray. Emitted so the (TS-only) detection
  // settings, the PURE decision-core inputs/outputs, the tray/auto-record runtime
  // state, and the browser in-call signal are fully visible as cross-process
  // contracts. The Python sidecar is NOT involved in PRD-11.
  AutoRecordSettings: autoRecordSettingsSchema,
  UpdateAutoRecordSettings: updateAutoRecordSettingsSchema,
  DetectionInputs: detectionInputsSchema,
  DetectionDecision: detectionDecisionSchema,
  AutoRecordState: autoRecordStateSchema,
  BrowserCallState: browserCallStateSchema,
  // PRD-12 file import. The sidecar validates the inbound `importFile`
  // notification against ImportFileRequest; ImportFileDone is emitted so the
  // terminal import contract is fully visible to Python.
  ImportFileRequest: importFileRequestSchema,
  ImportFileDone: importFileDoneSchema,
  // PRD-13 export & interop. Emitted so the export request/result contract is
  // fully visible to cross-process consumers (the transforms run in TS main).
  ExportFormat: exportFormatSchema,
  ExportMeetingParams: exportMeetingParamsSchema,
  ExportResult: exportResultSchema,
  // PRD-13 capture/privacy settings. CaptureSettings is the persisted shape;
  // CaptureCapability is the per-app-filter probe + decision surfaced to the UI.
  CaptureSettings: captureSettingsSchema,
  UpdateCaptureSettings: updateCaptureSettingsSchema,
  CaptureCapability: captureCapabilitySchema,
  // PRD-8 packaging + self-updater. UpdateManifest is the `version.json` release
  // feed the app fetches + sha256-verifies; UpdaterSettings is the persisted
  // policy (auto-check ON by default); UpdaterState is the runtime status pushed
  // to the renderer + tray. TS-only (no sidecar involvement); emitted for full
  // cross-process contract visibility.
  UpdateAsset: updateAssetSchema,
  UpdateManifest: updateManifestSchema,
  UpdaterSettings: updaterSettingsSchema,
  UpdateUpdaterSettings: updateUpdaterSettingsSchema,
  UpdaterState: updaterStateSchema,
  // PRD-9 pluggable transcription engines. TranscriptionSettings is the persisted
  // engine/model/language policy (default faster-whisper); the rest are emitted so
  // the engine-availability probe + the resolved status contract are fully visible
  // to cross-process consumers. The sidecar reads the chosen engine via the
  // LOQUI_TRANSCRIPTION_* env contract (transcription.ts), not these schemas at
  // runtime, but they document the shapes for parity.
  TranscriptionSettings: transcriptionSettingsSchema,
  UpdateTranscriptionSettings: updateTranscriptionSettingsSchema,
  TranscriptionEngineInfo: transcriptionEngineInfoSchema,
  TranscriptionStatus: transcriptionStatusSchema,
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
