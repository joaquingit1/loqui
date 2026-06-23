/**
 * Bounded audio-frame queue with a documented drop / backpressure policy
 * (PRD-1, unit "main-capture-orchestration").
 *
 * The renderer produces encoded binary PCM frames on a fixed cadence (20 ms by
 * default = 50 frames/s/source = 100 frames/s with both mic + system running).
 * Forwarding them onto the sidecar WS is best-effort: the WS may stall (slow
 * sidecar, reconnect in flight) while frames keep arriving. We must never let
 * an unbounded backlog grow — that would balloon memory and, worse, deliver a
 * huge burst of stale audio to the sidecar once the socket recovers.
 *
 * ## Drop / backpressure policy (documented & tested)
 *
 * This is a fixed-capacity FIFO ring buffer with a **drop-oldest** policy:
 *
 *   - `enqueue(frame)` appends to the tail. If the queue is already at
 *     `capacity`, the OLDEST frame is evicted first (and counted in
 *     `droppedFrames`) so the freshest audio is always retained. Audio that is
 *     seconds stale is worthless for a live transcript, so we favor recency.
 *   - `drainTo(send)` flushes the queue head-to-tail through `send`, which
 *     returns `false` to signal the transport is closed/full — draining then
 *     stops and the unsent frames stay queued (in order) for the next attempt.
 *   - The queue is **per-source**: mic and system never share a buffer, so a
 *     stalled system stream can never evict mic frames (or vice-versa). The
 *     orchestrator owns one FrameQueue per active (meeting, source).
 *
 * Capacity is expressed in frames; the default holds ~1 s of 20 ms frames per
 * source ({@link DEFAULT_FRAME_QUEUE_CAPACITY}). Counters (`droppedFrames`,
 * `enqueuedFrames`, `forwardedFrames`) are exposed for the level-meter / debug
 * UI and for tests to assert the policy without real audio.
 *
 * Pure data structure: no Electron / Node / WS deps, so it is fully hermetic.
 */

/**
 * Default ring-buffer capacity in frames. At the default 20 ms frame duration
 * (50 frames/s) this holds ~1 second of audio for a single source before
 * drop-oldest kicks in. Tunable per-construction.
 */
export const DEFAULT_FRAME_QUEUE_CAPACITY = 50 as const;

/** A frame is just its already-encoded bytes (16-byte header + pcm_s16le). */
export type Frame = Uint8Array;

/**
 * Sink for {@link FrameQueue.drainTo}. Returns `true` if the frame was accepted
 * by the transport (keep draining) or `false` if the transport is
 * closed/back-pressured (stop draining; the frame and the rest stay queued).
 * MUST NOT throw — the queue treats a throw as a hard stop and re-queues the
 * frame so no audio is silently lost on a transport error.
 */
export type FrameSink = (frame: Frame) => boolean;

/** Snapshot of a {@link FrameQueue}'s counters for debug / level-meter UI. */
export interface FrameQueueStats {
  /** Frames currently buffered (0..capacity). */
  readonly size: number;
  /** Fixed capacity in frames. */
  readonly capacity: number;
  /** Total frames ever enqueued (including ones later dropped). */
  readonly enqueuedFrames: number;
  /** Total frames evicted by the drop-oldest policy (queue-was-full). */
  readonly droppedFrames: number;
  /** Total frames successfully handed to the sink via drainTo. */
  readonly forwardedFrames: number;
}

/**
 * Fixed-capacity FIFO of encoded audio frames with a drop-oldest overflow
 * policy. See the file header for the full backpressure contract.
 */
export class FrameQueue {
  private readonly capacity: number;
  private readonly buf: (Frame | undefined)[];
  /** Index of the oldest element. */
  private head = 0;
  /** Number of buffered elements. */
  private count = 0;

  private enqueued = 0;
  private dropped = 0;
  private forwarded = 0;

  constructor(capacity: number = DEFAULT_FRAME_QUEUE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`FrameQueue capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Array<Frame | undefined>(capacity).fill(undefined);
  }

  /** Number of frames currently buffered. */
  get size(): number {
    return this.count;
  }

  /** True if the next enqueue would evict the oldest frame. */
  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /**
   * Append a frame to the tail. If the queue is full, evict the oldest frame
   * first (drop-oldest) and bump `droppedFrames`. Returns `true` if the frame
   * was admitted without an eviction, `false` if an eviction occurred.
   */
  enqueue(frame: Frame): boolean {
    this.enqueued += 1;
    let evicted = false;
    if (this.count === this.capacity) {
      // Drop the oldest: advance head, decrement count, count the drop.
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.count -= 1;
      this.dropped += 1;
      evicted = true;
    }
    const tail = (this.head + this.count) % this.capacity;
    this.buf[tail] = frame;
    this.count += 1;
    return !evicted;
  }

  /** Remove and return the oldest frame, or undefined if empty. */
  private dequeue(): Frame | undefined {
    if (this.count === 0) return undefined;
    const frame = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    return frame;
  }

  /** Put a frame back at the head (used when the sink rejects it). */
  private requeueHead(frame: Frame): void {
    this.head = (this.head - 1 + this.capacity) % this.capacity;
    this.buf[this.head] = frame;
    this.count += 1;
  }

  /**
   * Flush buffered frames head-to-tail through `sink` until it returns `false`
   * (transport closed/back-pressured) or the queue empties. A frame the sink
   * rejects — or one that makes the sink throw — is re-queued at the head (kept
   * in order) so draining can resume later without losing or reordering audio.
   *
   * @returns the number of frames successfully forwarded this call.
   */
  drainTo(sink: FrameSink): number {
    let sent = 0;
    while (this.count > 0) {
      const frame = this.dequeue();
      if (frame === undefined) break;
      let accepted: boolean;
      try {
        accepted = sink(frame);
      } catch {
        // Treat a throwing sink as a hard stop; keep the frame for retry.
        this.requeueHead(frame);
        break;
      }
      if (!accepted) {
        this.requeueHead(frame);
        break;
      }
      this.forwarded += 1;
      sent += 1;
    }
    return sent;
  }

  /** Drop every buffered frame (e.g. on stop / meeting change). Does not reset counters. */
  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }

  /** Snapshot the counters for debug / level-meter UI. */
  stats(): FrameQueueStats {
    return {
      size: this.count,
      capacity: this.capacity,
      enqueuedFrames: this.enqueued,
      droppedFrames: this.dropped,
      forwardedFrames: this.forwarded,
    };
  }
}
