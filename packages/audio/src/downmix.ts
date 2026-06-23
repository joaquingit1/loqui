/**
 * Channel downmix to mono.
 *
 * The Web Audio API delivers a render quantum as one `Float32Array` per
 * channel (`AudioWorkletProcessor`'s `inputs[i]` is `Float32Array[]`). We need
 * a single mono channel for the 16 kHz pcm_s16le wire format, so we average the
 * channels sample-by-sample (equal-gain mix). Averaging (rather than summing)
 * keeps the result within [-1, 1] given in-range inputs, which matters because
 * the next stage ({@link floatToPcm16}) clips anything outside that range.
 */

/**
 * Downmix N channels to a single mono `Float32Array` by averaging.
 *
 * - 0 channels        -> empty `Float32Array`.
 * - 1 channel         -> a COPY of that channel (callers may mutate downstream).
 * - N channels        -> per-sample mean across channels.
 *
 * If channels report differing lengths (should not happen within one render
 * quantum, but we are defensive), the output length is the MAX channel length
 * and shorter channels contribute 0 for their missing tail samples while the
 * divisor stays N (so a momentary length mismatch attenuates rather than
 * clicks).
 *
 * @returns a freshly allocated mono `Float32Array`.
 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  const n = channels.length;
  if (n === 0) {
    return new Float32Array(0);
  }
  if (n === 1) {
    return (channels[0] as Float32Array).slice();
  }

  let length = 0;
  for (const ch of channels) {
    if (ch.length > length) length = ch.length;
  }

  const out = new Float32Array(length);
  for (let c = 0; c < n; c++) {
    const ch = channels[c] as Float32Array;
    const len = ch.length;
    for (let i = 0; i < len; i++) {
      out[i] = (out[i] as number) + (ch[i] as number);
    }
  }
  const inv = 1 / n;
  for (let i = 0; i < length; i++) {
    out[i] = (out[i] as number) * inv;
  }
  return out;
}
