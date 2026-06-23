/**
 * Binary audio-frame codec for the capture pipeline.
 *
 * This is a thin, ergonomic wrapper over the canonical encoder/decoder in
 * `@loqui/shared` (the single source of truth for the 16-byte LE header
 * layout). It exists so the DSP/worklet side of `@loqui/audio` can speak in
 * terms of `{ source, seq, ts, pcm: Int16Array }` while delegating the actual
 * byte-laying to the shared, schema-aligned implementation. The header is
 * NEVER hand-rolled here.
 *
 * Wire layout (little-endian, owned by @loqui/shared):
 *   byte 0       magic = 0xA0
 *   byte 1       source (mic = 0, system = 1)
 *   bytes 2..3   reserved (0)
 *   bytes 4..7   uint32 seq (per-source, monotonic from 0)
 *   bytes 8..15  float64 timestampMs (ms since meeting start)
 *   bytes 16..N  pcm_s16le payload (16 kHz mono int16, little-endian)
 */
import {
  AUDIO_FRAME_HEADER_BYTES,
  decodeAudioFrame,
  encodeAudioFrame,
  type AudioSource,
} from "@loqui/shared";

/** A decoded capture frame in the DSP's native `Int16Array` PCM form. */
export interface DecodedFrame {
  source: AudioSource;
  /** Per-source monotonic sequence number, starting at 0. */
  seq: number;
  /** Capture timestamp in ms since meeting start (float64). */
  ts: number;
  /**
   * pcm_s16le samples as an `Int16Array`. This is a freshly allocated, host-
   * endianness `Int16Array` copy (NOT a view onto the input buffer), so it is
   * safe to retain and correct on big-endian hosts.
   */
  pcm: Int16Array;
}

/**
 * Reinterpret an `Int16Array` of PCM samples as little-endian bytes.
 *
 * On the overwhelmingly common little-endian host this is a zero-copy view of
 * the same backing memory. On a (hypothetical) big-endian host it byte-swaps
 * into a fresh buffer so the produced frame is always little-endian on the
 * wire, matching the shared contract.
 */
function pcm16ToLeBytes(pcm: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN_HOST) {
    return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  const out = new Uint8Array(pcm.byteLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(i * 2, pcm[i] as number, true);
  }
  return out;
}

/** Detect host endianness once (Int16Array shares memory with the byte view). */
const LITTLE_ENDIAN_HOST: boolean = (() => {
  const probe = new Uint16Array([0x0102]);
  const bytes = new Uint8Array(probe.buffer);
  return bytes[0] === 0x02;
})();

/**
 * Encode one capture frame to the canonical binary wire format.
 *
 * @param source  which independent stream this PCM belongs to (never mixed)
 * @param seq     per-source monotonic sequence number (>>> 0 to uint32)
 * @param ts      capture timestamp in ms since meeting start
 * @param pcm     16 kHz mono pcm_s16le samples for this frame
 * @returns a freshly allocated `Uint8Array` of length 16 + pcm.byteLength
 */
export function encodeFrame(
  source: AudioSource,
  seq: number,
  ts: number,
  pcm: Int16Array,
): Uint8Array {
  return encodeAudioFrame(
    { source, seq, timestampMs: ts },
    pcm16ToLeBytes(pcm),
  );
}

/**
 * Decode one capture frame produced by {@link encodeFrame} (or any conforming
 * encoder). Throws on a short buffer, bad magic, or unknown source byte (the
 * shared decoder enforces these). The returned `pcm` is an independent
 * `Int16Array` copy decoded as little-endian.
 */
export function decodeFrame(buf: Uint8Array): DecodedFrame {
  const decoded = decodeAudioFrame(buf);
  const payload = decoded.pcm;
  // The payload should be an even number of bytes (whole int16 samples). A
  // trailing odd byte is ignored rather than throwing — frame transport is
  // best-effort and the header has already validated.
  const sampleCount = payload.byteLength >> 1;
  const pcm = new Int16Array(sampleCount);
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(i * 2, true);
  }
  return {
    source: decoded.source,
    seq: decoded.seq,
    ts: decoded.timestampMs,
    pcm,
  };
}

export { AUDIO_FRAME_HEADER_BYTES };
