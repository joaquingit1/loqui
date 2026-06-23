/**
 * WebSocket control protocol between the Electron main process and the Python
 * sidecar. A small JSON-RPC-ish envelope carries request/response/notification
 * messages. Binary audio frames (see ./audio.ts) ride the same socket but are
 * NOT wrapped in this envelope — they are raw binary with a small header.
 */
import { z } from "zod";
import { PROTOCOL_VERSION } from "./constants.js";

/**
 * The single handshake line the sidecar prints to stdout BEFORE it begins
 * serving. The main process reads exactly one line, parses it as JSON, and
 * connects to ws://127.0.0.1:<port> presenting <token>.
 */
export const handshakeSchema = z.object({
  port: z.number().int().positive(),
  token: z.string().min(1),
  protocolVersion: z.string(),
});
export type Handshake = z.infer<typeof handshakeSchema>;

/** Request method names the main process may invoke on the sidecar. */
export const controlMethodSchema = z.enum(["ping", "getHealth", "shutdown"]);
export type ControlMethod = z.infer<typeof controlMethodSchema>;

/** Health payload returned by `getHealth` (and the HTTP `GET /health`). */
export const healthSchema = z.object({
  status: z.enum(["ok", "starting", "degraded"]).default("ok"),
  version: z.string().default("0.0.0"),
  protocolVersion: z.string().default(PROTOCOL_VERSION),
  models: z.record(z.string(), z.string()).default({}),
});
export type Health = z.infer<typeof healthSchema>;

/**
 * Request envelope: main → sidecar. `id` correlates the eventual response.
 * `params` is method-specific and optional.
 */
export const wsRequestSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  method: controlMethodSchema,
  params: z.unknown().optional(),
});
export type WsRequest = z.infer<typeof wsRequestSchema>;

/** Successful response envelope: sidecar → main. */
export const wsResponseSchema = z.object({
  type: z.literal("response"),
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown().optional(),
});
export type WsResponse = z.infer<typeof wsResponseSchema>;

/** Error response envelope: sidecar → main. */
export const wsErrorSchema = z.object({
  type: z.literal("error"),
  id: z.string().min(1).nullable().default(null),
  ok: z.literal(false),
  error: z.object({
    code: z.string().default("internal_error"),
    message: z.string().default(""),
  }),
});
export type WsError = z.infer<typeof wsErrorSchema>;

/**
 * Notification envelope: sidecar → main, unsolicited (no response expected).
 * Used to push transcript segments and job updates (see ./events.ts) and any
 * other server-initiated stream. `event` names the payload kind.
 */
export const wsNotificationSchema = z.object({
  type: z.literal("notification"),
  event: z.string().min(1),
  data: z.unknown(),
});
export type WsNotification = z.infer<typeof wsNotificationSchema>;

/** Any frame on the control channel (JSON, not binary audio). */
export const wsEnvelopeSchema = z.discriminatedUnion("type", [
  wsRequestSchema,
  wsResponseSchema,
  wsErrorSchema,
  wsNotificationSchema,
]);
export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;

/** `ping` request params (empty) and the `pong` result it produces. */
export const pingResultSchema = z.object({
  pong: z.literal(true).default(true),
  ts: z.number().default(0),
});
export type PingResult = z.infer<typeof pingResultSchema>;

/** `shutdown` result. */
export const shutdownResultSchema = z.object({
  shuttingDown: z.literal(true).default(true),
});
export type ShutdownResult = z.infer<typeof shutdownResultSchema>;
