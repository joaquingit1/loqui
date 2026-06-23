/**
 * Float32 <-> PCM16 conversion.
 *
 * The Web Audio API hands us audio as `Float32Array` samples nominally in
 * [-1, 1]. The wire format is `pcm_s16le` (signed 16-bit little-endian). This
 * module does the clamp-then-scale conversion, the only lossy step in the
 * capture DSP, and it must be defensive about garbage input (NaN/Inf/out of
 * range) because it sits on the hot path.
 */

/** int16 range. */
const INT16_MAX = 32767;
const INT16_MIN = -32768;

/**
 * Convert Float32 samples to signed 16-bit PCM.
 *
 * Each sample is:
 *   1. sanitized: NaN -> 0 (silence) so a single bad sample can't poison the
 *      stream;
 *   2. clamped to [-1, 1] (this also maps +/-Infinity to the rails);
 *   3. scaled to int16. We scale by 32767 for the positive side; the clamp at
 *      step 2 guarantees the product never exceeds the int16 range, and
 *      Math.round gives symmetric, nearest-integer quantization. The result is
 *      then re-clamped to [INT16_MIN, INT16_MAX] purely as a belt-and-braces
 *      guard against floating-point rounding at exactly +/-1.0.
 *
 * @returns a freshly allocated `Int16Array` of the same length as `input`.
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i] as number;
    // NaN !== NaN; map any NaN to silence.
    if (s !== s) {
      s = 0;
    } else if (s > 1) {
      s = 1;
    } else if (s < -1) {
      s = -1;
    }
    let v = Math.round(s * INT16_MAX);
    if (v > INT16_MAX) v = INT16_MAX;
    else if (v < INT16_MIN) v = INT16_MIN;
    out[i] = v;
  }
  return out;
}

/**
 * Convert signed 16-bit PCM back to Float32 in [-1, 1]. Inverse-ish of
 * {@link floatToPcm16} (quantization is lossy). Negative full-scale (-32768)
 * maps to slightly below -1.0; we divide by 32768 so the round-trip of any
 * value produced by {@link floatToPcm16} stays within [-1, 1).
 *
 * Provided mainly for tests and any future playback/metering path.
 */
export function pcm16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = (input[i] as number) / 32768;
  }
  return out;
}
