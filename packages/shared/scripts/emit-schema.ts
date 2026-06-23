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
