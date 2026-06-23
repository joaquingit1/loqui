/**
 * Audio stream protocol (main → sidecar).
 *
 * Control frames (`audioStart` / `audioStop`) are sent as JSON notifications
 * over the WS control channel. The PCM payload itself is sent as BINARY
 * WebSocket frames, NOT JSON, to avoid base64 overhead.
 *
 * Binary framing (little-endian header, then raw PCM):
 *   byte 0       : magic = 0xA0
 *   byte 1       : source (0 = mic, 1 = system)
 *   bytes 2..3   : reserved (0)
 *   bytes 4..7   : uint32 sequence number
 *   bytes 8..15  : float64 captureTimestampMs (ms since meeting start)
 *   bytes 16..N  : PCM samples, pcm_s16le, mono, 16 kHz
 *
 * The two sources (mic="You", system="They") are independent end-to-end and
 * are correlated only by their capture timestamps — never mixed into one
 * stream.
 */
import { z } from "zod";
import {
  AUDIO_CHANNELS,
  AUDIO_ENCODING,
  AUDIO_SAMPLE_RATE,
} from "./constants.js";

export const audioSourceSchema = z.enum(["mic", "system"]);
export type AudioSource = z.infer<typeof audioSourceSchema>;

export const audioEncodingSchema = z.literal("pcm_s16le").default(AUDIO_ENCODING);
export type AudioEncoding = z.infer<typeof audioEncodingSchema>;

/** Begin a capture stream for one source of one meeting. */
export const audioStartSchema = z.object({
  meetingId: z.string().uuid(),
  source: audioSourceSchema,
  sampleRate: z.literal(AUDIO_SAMPLE_RATE).default(AUDIO_SAMPLE_RATE),
  channels: z.literal(AUDIO_CHANNELS).default(AUDIO_CHANNELS),
  encoding: audioEncodingSchema,
});
export type AudioStart = z.infer<typeof audioStartSchema>;

/** End a capture stream for one source of one meeting. */
export const audioStopSchema = z.object({
  meetingId: z.string().uuid(),
  source: audioSourceSchema,
});
export type AudioStop = z.infer<typeof audioStopSchema>;

/**
 * Notification `event` names used to carry the audio control frames on the WS
 * control channel. Binary PCM rides as raw binary frames, not these.
 */
export const AUDIO_EVENT = {
  start: "audioStart",
  stop: "audioStop",
} as const;

/** Fixed-byte sizes for the binary PCM frame header (see file header). */
export const AUDIO_FRAME_HEADER_BYTES = 16 as const;
export const AUDIO_FRAME_MAGIC = 0xa0 as const;
/** source byte values in the binary header. */
export const AUDIO_FRAME_SOURCE = { mic: 0, system: 1 } as const;
