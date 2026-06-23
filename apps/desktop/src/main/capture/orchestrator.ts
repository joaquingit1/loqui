/**
 * Capture orchestration: the audioStart/Stop sequencing + bounded frame
 * forwarding state machine (PRD-1, unit "main-capture-orchestration").
 *
 * Owns the per-meeting, per-source capture lifecycle on top of the live sidecar
 * WS. It depends only on the narrow {@link AudioSupervisor} surface that the
 * Foundation exposes (`sendControlNotification`, `sendAudioFrame`,
 * `setActiveMeeting` / `getActiveMeeting`, `isConnected`) so it is fully
 * hermetic — tests drive it with a fake supervisor, no Electron / WS / audio.
 *
 * ## Independence invariant (mic vs system)
 *
 * The two sources are independent end-to-end. The orchestrator keeps a SEPARATE
 * {@link FrameQueue} per (meeting, source); a stalled system stream can never
 * evict mic frames. Every control frame and every forwarded binary frame is
 * per-source. mic = source byte 0, system = source byte 1 (enforced by the
 * shared frame codec, not here).
 *
 * ## Control-frame ordering (the contract this module guarantees)
 *
 *   1. `start(meetingId, source)` -> sends the `audioStart` notification for
 *      that source BEFORE any of its binary frames, and marks the meeting active
 *      on the FIRST source to start (so the frame IPC handler accepts frames).
 *   2. `enqueueFrame(...)` buffers + best-effort forwards binary frames; only
 *      for the active meeting + a started source — everything else is dropped.
 *   3. `stop(meetingId, source)` -> flushes that source's queue, sends
 *      `audioStop` AFTER the frames, and clears the active meeting only when the
 *      LAST source of that meeting stops.
 *
 * ## Backpressure / drop policy
 *
 * Forwarding is best-effort. On enqueue we immediately try to drain to the
 * supervisor; if the WS isn't connected the frame stays queued (drop-oldest on
 * overflow per {@link FrameQueue}). We never block and never throw on the hot
 * path — audio is sacrificed before correctness of the control channel.
 */
import {
  AUDIO_EVENT,
  audioStartSchema,
  audioStopSchema,
  decodeAudioFrame,
  type AudioCaptureResult,
  type AudioCaptureStartParams,
  type AudioCaptureStopParams,
  type AudioFrameMessage,
  type AudioSource,
} from "@loqui/shared";
import { DEFAULT_FRAME_QUEUE_CAPACITY, FrameQueue } from "./frame-queue.js";

/**
 * The supervisor surface the orchestrator needs. Structurally identical to the
 * `AudioSupervisor` the Foundation defines so it can be passed straight through.
 */
export interface AudioSupervisor {
  sendAudioFrame(bytes: Uint8Array): boolean;
  sendControlNotification(event: string, data: unknown): boolean;
  setActiveMeeting(id: string | null): void;
  getActiveMeeting(): string | null;
  isConnected(): boolean;
}

export interface CaptureOrchestratorOptions {
  supervisor: AudioSupervisor;
  /** Per-source ring-buffer capacity in frames. Defaults to ~1 s of 20 ms frames. */
  queueCapacity?: number;
  /**
   * Validate each frame before forwarding. Defaults to the shared
   * {@link decodeAudioFrame} (malformed frames are dropped, never forwarded).
   * Injectable so tests can assert the drop path without hand-rolling headers.
   */
  validateFrame?: (bytes: Uint8Array) => void;
}

/** Per-source state for one active meeting. */
interface SourceState {
  queue: FrameQueue;
}

/** Snapshot of one source's queue stats, for debug / level-meter UI. */
export interface CaptureSourceStats {
  source: AudioSource;
  queue: ReturnType<FrameQueue["stats"]>;
}

/**
 * State machine for the dual-stream capture lifecycle. One instance per app
 * (the Foundation creates it and the audio IPC layer delegates to it).
 */
export class CaptureOrchestrator {
  private readonly supervisor: AudioSupervisor;
  private readonly queueCapacity: number;
  private readonly validateFrame: (bytes: Uint8Array) => void;

  /** meetingId -> (source -> state). A meeting appears only while a source is started. */
  private readonly meetings = new Map<string, Map<AudioSource, SourceState>>();

  constructor(opts: CaptureOrchestratorOptions) {
    this.supervisor = opts.supervisor;
    this.queueCapacity = opts.queueCapacity ?? DEFAULT_FRAME_QUEUE_CAPACITY;
    this.validateFrame = opts.validateFrame ?? ((bytes) => void decodeAudioFrame(bytes));
  }

  /**
   * Begin capturing one source of one meeting: validate params, ensure the WS
   * is up, send `audioStart` (before any frames), mark the meeting active on
   * the first source, and allocate that source's frame queue. Idempotent per
   * source — a duplicate start re-sends `audioStart` but keeps the same queue.
   */
  start(params: AudioCaptureStartParams): AudioCaptureResult {
    const parsed = audioStartSchema.safeParse({
      meetingId: params.meetingId,
      source: params.source,
    });
    if (!parsed.success) {
      return { ok: false, code: "invalid_params", message: parsed.error.message };
    }
    if (!this.supervisor.isConnected()) {
      return { ok: false, code: "sidecar_unavailable", message: "sidecar not connected" };
    }

    // audioStart MUST precede this source's binary frames.
    this.supervisor.sendControlNotification(AUDIO_EVENT.start, parsed.data);

    let sources = this.meetings.get(params.meetingId);
    if (!sources) {
      sources = new Map();
      this.meetings.set(params.meetingId, sources);
    }
    if (!sources.has(params.source)) {
      sources.set(params.source, { queue: new FrameQueue(this.queueCapacity) });
    }
    // Mark active on the first source of this meeting (so frames are accepted).
    this.supervisor.setActiveMeeting(params.meetingId);
    return { ok: true };
  }

  /**
   * Stop capturing one source: flush its queue, send `audioStop` (after the
   * frames), drop the source state, and clear the active meeting only when the
   * LAST source for that meeting has stopped. Tolerant of an unknown
   * meeting/source (returns ok — stop is idempotent).
   */
  stop(params: AudioCaptureStopParams): AudioCaptureResult {
    const parsed = audioStopSchema.safeParse({
      meetingId: params.meetingId,
      source: params.source,
    });
    if (!parsed.success) {
      return { ok: false, code: "invalid_params", message: parsed.error.message };
    }

    const sources = this.meetings.get(params.meetingId);
    const state = sources?.get(params.source);
    if (state) {
      // Best-effort flush of remaining buffered frames before closing.
      this.flush(state.queue);
    }

    // audioStop AFTER this source's frames.
    this.supervisor.sendControlNotification(AUDIO_EVENT.stop, parsed.data);

    if (sources) {
      sources.delete(params.source);
      if (sources.size === 0) {
        this.meetings.delete(params.meetingId);
        // Clear active only when the LAST source of THIS meeting stops, and
        // only if it is still the active one (a newer meeting may have started).
        if (this.supervisor.getActiveMeeting() === params.meetingId) {
          this.supervisor.setActiveMeeting(null);
        }
      }
    }
    return { ok: true };
  }

  /**
   * Hot path: accept one encoded binary frame from the renderer, buffer it in
   * its per-source queue, and best-effort drain to the WS. Frames are dropped
   * (never forwarded) when:
   *   - the meeting is not the active one (stale renderer),
   *   - the source was never started for that meeting,
   *   - the frame fails validation (bad magic / short / unknown source).
   * Never throws.
   *
   * @returns true if the frame was admitted to a queue, false if it was dropped.
   */
  enqueueFrame(message: AudioFrameMessage): boolean {
    if (!message || typeof message !== "object") return false;
    if (this.supervisor.getActiveMeeting() !== message.meetingId) return false;
    const state = this.meetings.get(message.meetingId)?.get(message.source);
    if (!state) return false;
    const buf = message.frame;
    if (!(buf instanceof ArrayBuffer)) return false;
    const bytes = new Uint8Array(buf);
    try {
      this.validateFrame(bytes);
    } catch {
      return false; // malformed -> drop, never forward.
    }
    state.queue.enqueue(bytes);
    // Opportunistically push toward the WS; whatever doesn't fit stays queued.
    this.flush(state.queue);
    return true;
  }

  /** Drain a queue to the supervisor; stops on the first frame the WS rejects. */
  private flush(queue: FrameQueue): void {
    queue.drainTo((frame) => this.supervisor.sendAudioFrame(frame));
  }

  /** Whether the given source of the given meeting is currently started. */
  isStarted(meetingId: string, source: AudioSource): boolean {
    return this.meetings.get(meetingId)?.has(source) ?? false;
  }

  /** Sources currently started for a meeting (independent mic / system tracking). */
  startedSources(meetingId: string): AudioSource[] {
    const sources = this.meetings.get(meetingId);
    return sources ? [...sources.keys()] : [];
  }

  /** Per-source queue stats for the active meeting (debug / level-meter UI). */
  stats(meetingId: string): CaptureSourceStats[] {
    const sources = this.meetings.get(meetingId);
    if (!sources) return [];
    return [...sources.entries()].map(([source, state]) => ({
      source,
      queue: state.queue.stats(),
    }));
  }

  /**
   * Tear down all capture state (e.g. on supervisor disconnect / app quit):
   * flush + drop every queue and clear the active meeting. Sends `audioStop`
   * for each still-started source so the sidecar finalizes its WAVs.
   */
  stopAll(): void {
    for (const [meetingId, sources] of this.meetings) {
      for (const [source, state] of sources) {
        this.flush(state.queue);
        this.supervisor.sendControlNotification(AUDIO_EVENT.stop, { meetingId, source });
      }
    }
    this.meetings.clear();
    this.supervisor.setActiveMeeting(null);
  }
}
