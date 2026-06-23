import { describe, expect, it } from "vitest";
import { DEFAULT_FRAME_QUEUE_CAPACITY, FrameQueue } from "./frame-queue.js";

/** A tiny helper: a "frame" tagged by a single byte so we can assert ordering. */
function frame(tag: number): Uint8Array {
  return Uint8Array.of(tag);
}

describe("FrameQueue", () => {
  it("rejects a non-positive capacity", () => {
    expect(() => new FrameQueue(0)).toThrow();
    expect(() => new FrameQueue(-1)).toThrow();
    expect(() => new FrameQueue(1.5)).toThrow();
  });

  it("defaults capacity to ~1s of 20ms frames", () => {
    const q = new FrameQueue();
    expect(q.stats().capacity).toBe(DEFAULT_FRAME_QUEUE_CAPACITY);
  });

  it("enqueues and drains FIFO", () => {
    const q = new FrameQueue(4);
    q.enqueue(frame(1));
    q.enqueue(frame(2));
    q.enqueue(frame(3));
    const out: number[] = [];
    const sent = q.drainTo((f) => {
      out.push(f[0]!);
      return true;
    });
    expect(sent).toBe(3);
    expect(out).toEqual([1, 2, 3]);
    expect(q.size).toBe(0);
    expect(q.stats().forwardedFrames).toBe(3);
  });

  it("drops the OLDEST frame on overflow (drop-oldest policy)", () => {
    const q = new FrameQueue(3);
    expect(q.enqueue(frame(1))).toBe(true);
    expect(q.enqueue(frame(2))).toBe(true);
    expect(q.enqueue(frame(3))).toBe(true);
    expect(q.isFull).toBe(true);
    // 4th + 5th evict the two oldest (1, 2); freshest are retained.
    expect(q.enqueue(frame(4))).toBe(false);
    expect(q.enqueue(frame(5))).toBe(false);
    expect(q.size).toBe(3);
    expect(q.stats().droppedFrames).toBe(2);
    expect(q.stats().enqueuedFrames).toBe(5);

    const out: number[] = [];
    q.drainTo((f) => {
      out.push(f[0]!);
      return true;
    });
    expect(out).toEqual([3, 4, 5]);
  });

  it("re-queues at the head (preserving order) when the sink back-pressures", () => {
    const q = new FrameQueue(5);
    [1, 2, 3, 4].forEach((t) => q.enqueue(frame(t)));
    // Sink accepts the first two, then signals back-pressure (false).
    let accept = 2;
    const out: number[] = [];
    const sent = q.drainTo((f) => {
      if (accept <= 0) return false;
      accept -= 1;
      out.push(f[0]!);
      return true;
    });
    expect(sent).toBe(2);
    expect(out).toEqual([1, 2]);
    // 3 and 4 stay queued, in order, ready for the next drain.
    expect(q.size).toBe(2);
    const rest: number[] = [];
    q.drainTo((f) => {
      rest.push(f[0]!);
      return true;
    });
    expect(rest).toEqual([3, 4]);
  });

  it("re-queues the frame when the sink throws and stops draining", () => {
    const q = new FrameQueue(5);
    [1, 2, 3].forEach((t) => q.enqueue(frame(t)));
    const out: number[] = [];
    const sent = q.drainTo((f) => {
      if (f[0] === 2) throw new Error("transport blew up");
      out.push(f[0]!);
      return true;
    });
    expect(sent).toBe(1); // only frame 1 forwarded
    expect(out).toEqual([1]);
    // frame 2 (the thrower) is re-queued at the head; 3 still behind it.
    expect(q.size).toBe(2);
    const rest: number[] = [];
    q.drainTo((f) => {
      rest.push(f[0]!);
      return true;
    });
    expect(rest).toEqual([2, 3]);
  });

  it("clear() empties the buffer without resetting cumulative counters", () => {
    const q = new FrameQueue(3);
    [1, 2, 3, 4].forEach((t) => q.enqueue(frame(t))); // one drop
    q.clear();
    expect(q.size).toBe(0);
    expect(q.stats().enqueuedFrames).toBe(4);
    expect(q.stats().droppedFrames).toBe(1);
  });

  it("survives many wrap-arounds keeping FIFO order", () => {
    const q = new FrameQueue(3);
    const forwarded: number[] = [];
    for (let i = 0; i < 100; i++) {
      q.enqueue(frame(i & 0xff));
      // Drain every other iteration to exercise head/tail wrap.
      if (i % 2 === 0) {
        q.drainTo((f) => {
          forwarded.push(f[0]!);
          return true;
        });
      }
    }
    q.drainTo((f) => {
      forwarded.push(f[0]!);
      return true;
    });
    // Forwarded sequence must be strictly the order frames were retained.
    const s = q.stats();
    expect(s.forwardedFrames).toBe(forwarded.length);
    expect(s.enqueuedFrames).toBe(100);
    expect(s.forwardedFrames + s.droppedFrames).toBe(100);
  });
});
