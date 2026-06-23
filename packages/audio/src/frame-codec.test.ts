import { describe, expect, it } from "vitest";
import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_FRAME_MAGIC,
  AUDIO_FRAME_OFFSET,
  AUDIO_FRAME_SOURCE,
} from "@loqui/shared";
import { decodeFrame, encodeFrame } from "./frame-codec.js";

function pcm(...samples: number[]): Int16Array {
  return Int16Array.from(samples);
}

describe("encodeFrame / decodeFrame round-trip", () => {
  it("preserves source, seq, ts, and pcm exactly for mic", () => {
    const samples = pcm(0, 1, -1, 32767, -32768, 12345, -12345);
    const frame = encodeFrame("mic", 7, 123.5, samples);
    const decoded = decodeFrame(frame);
    expect(decoded.source).toBe("mic");
    expect(decoded.seq).toBe(7);
    expect(decoded.ts).toBe(123.5);
    expect(Array.from(decoded.pcm)).toEqual(Array.from(samples));
  });

  it("preserves source byte for system", () => {
    const frame = encodeFrame("system", 0, 0, pcm(1, 2, 3));
    expect(frame[AUDIO_FRAME_OFFSET.source]).toBe(AUDIO_FRAME_SOURCE.system);
    expect(decodeFrame(frame).source).toBe("system");
  });

  it("writes the canonical 16-byte header (magic + source + reserved=0)", () => {
    const frame = encodeFrame("mic", 1, 1, pcm(9));
    expect(frame[AUDIO_FRAME_OFFSET.magic]).toBe(AUDIO_FRAME_MAGIC);
    expect(frame[AUDIO_FRAME_OFFSET.source]).toBe(AUDIO_FRAME_SOURCE.mic);
    expect(frame[AUDIO_FRAME_OFFSET.reserved]).toBe(0);
    expect(frame[AUDIO_FRAME_OFFSET.reserved + 1]).toBe(0);
    expect(frame.byteLength).toBe(AUDIO_FRAME_HEADER_BYTES + 2);
  });

  it("encodes seq as little-endian uint32", () => {
    const frame = encodeFrame("mic", 0x01020304, 0, pcm());
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint32(AUDIO_FRAME_OFFSET.seq, true)).toBe(0x01020304);
    expect(decodeFrame(frame).seq).toBe(0x01020304);
  });

  it("encodes a float64 fractional timestamp losslessly", () => {
    const ts = 1234.56789;
    const decoded = decodeFrame(encodeFrame("mic", 0, ts, pcm(1)));
    expect(decoded.ts).toBe(ts);
  });

  it("handles an empty pcm payload", () => {
    const frame = encodeFrame("mic", 3, 5, pcm());
    expect(frame.byteLength).toBe(AUDIO_FRAME_HEADER_BYTES);
    const decoded = decodeFrame(frame);
    expect(decoded.pcm.length).toBe(0);
    expect(decoded.seq).toBe(3);
    expect(decoded.ts).toBe(5);
  });

  it("handles a length-1 pcm payload", () => {
    const decoded = decodeFrame(encodeFrame("system", 1, 1, pcm(-9999)));
    expect(Array.from(decoded.pcm)).toEqual([-9999]);
  });

  it("decode produces an independent Int16Array copy (not a view)", () => {
    const frame = encodeFrame("mic", 0, 0, pcm(100, 200));
    const decoded = decodeFrame(frame);
    decoded.pcm[0] = 0;
    // re-decoding the original frame still yields the original samples
    expect(Array.from(decodeFrame(frame).pcm)).toEqual([100, 200]);
  });
});

describe("seq overflow near uint32 max", () => {
  it("round-trips seq = 0xFFFFFFFF (uint32 max)", () => {
    const decoded = decodeFrame(encodeFrame("mic", 0xffffffff, 0, pcm(1)));
    expect(decoded.seq).toBe(0xffffffff);
  });

  it("wraps via >>> 0 when seq is given as max+1", () => {
    // 0x1_0000_0000 >>> 0 === 0
    const decoded = decodeFrame(encodeFrame("mic", 0x100000000, 0, pcm(1)));
    expect(decoded.seq).toBe(0);
  });

  it("treats a wrapped-up increment the way the worklet would", () => {
    let seq = 0xfffffffe;
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(decodeFrame(encodeFrame("mic", seq, 0, pcm(1))).seq);
      seq = (seq + 1) >>> 0;
    }
    expect(seen).toEqual([0xfffffffe, 0xffffffff, 0, 1]);
  });
});

describe("decodeFrame adversarial inputs", () => {
  it("throws on a buffer shorter than the header", () => {
    expect(() => decodeFrame(new Uint8Array(0))).toThrow();
    expect(() => decodeFrame(new Uint8Array(AUDIO_FRAME_HEADER_BYTES - 1))).toThrow();
  });

  it("throws on a bad magic byte", () => {
    const frame = encodeFrame("mic", 0, 0, pcm(1));
    frame[AUDIO_FRAME_OFFSET.magic] = 0x00;
    expect(() => decodeFrame(frame)).toThrow(/magic/i);
  });

  it("throws on an unknown source byte", () => {
    const frame = encodeFrame("mic", 0, 0, pcm(1));
    frame[AUDIO_FRAME_OFFSET.source] = 0x7f;
    expect(() => decodeFrame(frame)).toThrow(/source/i);
  });

  it("ignores a trailing odd byte (whole int16 samples only)", () => {
    const frame = encodeFrame("mic", 0, 0, pcm(1, 2));
    // append one extra byte -> payload is now odd-length
    const padded = new Uint8Array(frame.byteLength + 1);
    padded.set(frame);
    const decoded = decodeFrame(padded);
    expect(Array.from(decoded.pcm)).toEqual([1, 2]);
  });

  it("decodes a frame that is a subarray view at a non-zero offset", () => {
    const frame = encodeFrame("system", 42, 9.5, pcm(7, 8, 9));
    const backing = new Uint8Array(frame.byteLength + 5);
    backing.set(frame, 5);
    const view = backing.subarray(5);
    const decoded = decodeFrame(view);
    expect(decoded.source).toBe("system");
    expect(decoded.seq).toBe(42);
    expect(decoded.ts).toBe(9.5);
    expect(Array.from(decoded.pcm)).toEqual([7, 8, 9]);
  });
});
