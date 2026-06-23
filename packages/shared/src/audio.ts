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

/** Byte offsets inside the 16-byte little-endian binary frame header. */
export const AUDIO_FRAME_OFFSET = {
  /** byte 0: magic = {@link AUDIO_FRAME_MAGIC}. */
  magic: 0,
  /** byte 1: source = {@link AUDIO_FRAME_SOURCE}[source]. */
  source: 1,
  /** bytes 2..3: reserved (must be 0). */
  reserved: 2,
  /** bytes 4..7: uint32 sequence number (per-source, monotonic from 0). */
  seq: 4,
  /** bytes 8..15: float64 captureTimestampMs (ms since meeting start). */
  timestampMs: 8,
} as const;

/** Map the `mic`/`system` source byte back to its {@link AudioSource}. */
export const AUDIO_FRAME_SOURCE_BY_BYTE: Readonly<Record<number, AudioSource>> = {
  0: "mic",
  1: "system",
};

/** Decoded view of a binary audio frame header (see file header for layout). */
export interface AudioFrameHeader {
  source: AudioSource;
  /** Per-source monotonic sequence number, starting at 0. */
  seq: number;
  /** Capture timestamp in ms since meeting start (float64). */
  timestampMs: number;
}

/** A fully decoded binary audio frame: header + its pcm_s16le payload bytes. */
export interface DecodedAudioFrame extends AudioFrameHeader {
  /** Raw little-endian pcm_s16le payload (16 kHz mono), header stripped. */
  pcm: Uint8Array;
}

/**
 * Encode one binary audio frame: 16-byte LE header + the raw pcm_s16le payload.
 *
 * Pure (no DOM/Node deps) so it is shared by the renderer-side encoder
 * (packages/audio) AND testable with synthetic PCM. `pcm` MUST already be
 * 16 kHz mono pcm_s16le bytes (little-endian int16 samples).
 *
 * @returns a freshly allocated Uint8Array of length 16 + pcm.byteLength.
 */
export function encodeAudioFrame(header: AudioFrameHeader, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(AUDIO_FRAME_OFFSET.magic, AUDIO_FRAME_MAGIC);
  view.setUint8(AUDIO_FRAME_OFFSET.source, AUDIO_FRAME_SOURCE[header.source]);
  // reserved bytes 2..3 stay 0 (Uint8Array is zero-initialized).
  view.setUint32(AUDIO_FRAME_OFFSET.seq, header.seq >>> 0, true);
  view.setFloat64(AUDIO_FRAME_OFFSET.timestampMs, header.timestampMs, true);
  out.set(pcm, AUDIO_FRAME_HEADER_BYTES);
  return out;
}

/**
 * Decode one binary audio frame produced by {@link encodeAudioFrame}.
 *
 * Throws if the buffer is shorter than the header or the magic byte / source
 * byte are not recognized. The returned `pcm` is a VIEW onto the same backing
 * buffer (no copy) — callers that retain it past the frame's lifetime should
 * copy it.
 */
export function decodeAudioFrame(frame: Uint8Array): DecodedAudioFrame {
  if (frame.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    throw new Error(
      `audio frame too short: ${frame.byteLength} < ${AUDIO_FRAME_HEADER_BYTES}`,
    );
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const magic = view.getUint8(AUDIO_FRAME_OFFSET.magic);
  if (magic !== AUDIO_FRAME_MAGIC) {
    throw new Error(`bad audio frame magic: 0x${magic.toString(16)}`);
  }
  const sourceByte = view.getUint8(AUDIO_FRAME_OFFSET.source);
  const source = AUDIO_FRAME_SOURCE_BY_BYTE[sourceByte];
  if (source === undefined) {
    throw new Error(`unknown audio frame source byte: ${sourceByte}`);
  }
  return {
    source,
    seq: view.getUint32(AUDIO_FRAME_OFFSET.seq, true),
    timestampMs: view.getFloat64(AUDIO_FRAME_OFFSET.timestampMs, true),
    pcm: frame.subarray(AUDIO_FRAME_HEADER_BYTES),
  };
}
