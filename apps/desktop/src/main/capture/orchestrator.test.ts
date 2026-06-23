import { describe, expect, it } from "vitest";
import {
  AUDIO_EVENT,
  encodeAudioFrame,
  type AudioFrameMessage,
  type AudioSource,
} from "@loqui/shared";
import { CaptureOrchestrator, type AudioSupervisor } from "./orchestrator.js";

const MEETING = "11111111-1111-1111-1111-111111111111";
const MEETING_B = "22222222-2222-2222-2222-222222222222";

interface Notification {
  event: string;
  data: unknown;
}

/** Fully in-memory supervisor fake: records control frames + binary frames. */
class FakeSupervisor implements AudioSupervisor {
  notifications: Notification[] = [];
  framesSent: Uint8Array[] = [];
  private activeMeeting: string | null = null;
  connected = true;
  /** When set, sendAudioFrame returns false (WS back-pressure / closed). */
  rejectFrames = false;

  sendAudioFrame(bytes: Uint8Array): boolean {
    if (this.rejectFrames || !this.connected) return false;
    this.framesSent.push(bytes);
    return true;
  }
  sendControlNotification(event: string, data: unknown): boolean {
    this.notifications.push({ event, data });
    return this.connected;
  }
  setActiveMeeting(id: string | null): void {
    this.activeMeeting = id;
  }
  getActiveMeeting(): string | null {
    return this.activeMeeting;
  }
  isConnected(): boolean {
    return this.connected;
  }
}

/** Build a valid encoded frame for a source so decodeAudioFrame accepts it. */
function makeFrame(meetingId: string, source: AudioSource, seq = 0): AudioFrameMessage {
  const pcm = new Uint8Array(640); // 20ms @ 16kHz mono s16le
  const encoded = encodeAudioFrame({ source, seq, timestampMs: seq * 20 }, pcm);
  // Copy into a standalone ArrayBuffer (mirrors the transferred renderer buffer).
  const ab = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  return { meetingId, source, frame: ab };
}

function events(sup: FakeSupervisor): string[] {
  return sup.notifications.map((n) => n.event);
}

describe("CaptureOrchestrator start/stop sequencing", () => {
  it("sends audioStart and marks the meeting active on first source", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });

    const res = orch.start({ meetingId: MEETING, source: "mic" });
    expect(res.ok).toBe(true);
    expect(events(sup)).toEqual([AUDIO_EVENT.start]);
    expect(sup.getActiveMeeting()).toBe(MEETING);
    expect(orch.isStarted(MEETING, "mic")).toBe(true);
    expect(orch.isStarted(MEETING, "system")).toBe(false);
  });

  it("rejects start when the sidecar is not connected", () => {
    const sup = new FakeSupervisor();
    sup.connected = false;
    const orch = new CaptureOrchestrator({ supervisor: sup });
    const res = orch.start({ meetingId: MEETING, source: "mic" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("sidecar_unavailable");
    expect(sup.getActiveMeeting()).toBeNull();
  });

  it("rejects start with an invalid meeting id", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    const res = orch.start({ meetingId: "not-a-uuid", source: "mic" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("invalid_params");
    expect(sup.notifications).toHaveLength(0);
  });

  it("keeps the meeting active until the LAST source stops", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });

    orch.start({ meetingId: MEETING, source: "mic" });
    orch.start({ meetingId: MEETING, source: "system" });
    expect(sup.getActiveMeeting()).toBe(MEETING);

    // Stop mic: still active because system is running.
    orch.stop({ meetingId: MEETING, source: "mic" });
    expect(sup.getActiveMeeting()).toBe(MEETING);
    expect(orch.startedSources(MEETING)).toEqual(["system"]);

    // Stop system: now the last source -> active cleared.
    orch.stop({ meetingId: MEETING, source: "system" });
    expect(sup.getActiveMeeting()).toBeNull();
    expect(orch.startedSources(MEETING)).toEqual([]);

    // Two starts + two stops -> 4 control frames in order.
    expect(events(sup)).toEqual([
      AUDIO_EVENT.start,
      AUDIO_EVENT.start,
      AUDIO_EVENT.stop,
      AUDIO_EVENT.stop,
    ]);
  });

  it("stop is idempotent / tolerant of an unknown source", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    const res = orch.stop({ meetingId: MEETING, source: "mic" });
    expect(res.ok).toBe(true);
    // audioStop is still sent (best-effort), but active meeting stays null.
    expect(events(sup)).toEqual([AUDIO_EVENT.stop]);
    expect(sup.getActiveMeeting()).toBeNull();
  });

  it("does not clear active meeting if a newer meeting became active", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    orch.start({ meetingId: MEETING, source: "mic" });
    // A newer meeting starts and becomes active.
    orch.start({ meetingId: MEETING_B, source: "mic" });
    expect(sup.getActiveMeeting()).toBe(MEETING_B);
    // Stopping the OLD meeting's last source must not clear the newer active one.
    orch.stop({ meetingId: MEETING, source: "mic" });
    expect(sup.getActiveMeeting()).toBe(MEETING_B);
  });
});

describe("CaptureOrchestrator frame forwarding + backpressure", () => {
  it("forwards a valid frame for an active, started source", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    orch.start({ meetingId: MEETING, source: "mic" });

    const admitted = orch.enqueueFrame(makeFrame(MEETING, "mic", 0));
    expect(admitted).toBe(true);
    expect(sup.framesSent).toHaveLength(1);
  });

  it("drops frames whose meeting is not the active one", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    orch.start({ meetingId: MEETING, source: "mic" });
    // Frame tagged for a different meeting.
    const admitted = orch.enqueueFrame(makeFrame(MEETING_B, "mic", 0));
    expect(admitted).toBe(false);
    expect(sup.framesSent).toHaveLength(0);
  });

  it("drops frames for a source that was never started", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    orch.start({ meetingId: MEETING, source: "mic" });
    // system never started -> dropped even though the meeting is active.
    const admitted = orch.enqueueFrame(makeFrame(MEETING, "system", 0));
    expect(admitted).toBe(false);
    expect(sup.framesSent).toHaveLength(0);
  });

  it("drops a malformed frame (bad bytes), never forwards it", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    orch.start({ meetingId: MEETING, source: "mic" });
    const bad: AudioFrameMessage = {
      meetingId: MEETING,
      source: "mic",
      frame: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, // too short / bad magic
    };
    expect(orch.enqueueFrame(bad)).toBe(false);
    expect(sup.framesSent).toHaveLength(0);
  });

  it("mic and system queues are independent (system stall never drops mic)", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup, queueCapacity: 2 });
    orch.start({ meetingId: MEETING, source: "mic" });
    orch.start({ meetingId: MEETING, source: "system" });

    // Make the WS reject everything so frames pile up in their queues.
    sup.rejectFrames = true;
    // Overflow the SYSTEM queue (capacity 2) with 5 frames -> 3 drops on system.
    for (let i = 0; i < 5; i++) orch.enqueueFrame(makeFrame(MEETING, "system", i));
    // Mic gets exactly 2 (no overflow).
    for (let i = 0; i < 2; i++) orch.enqueueFrame(makeFrame(MEETING, "mic", i));

    const stats = Object.fromEntries(orch.stats(MEETING).map((s) => [s.source, s.queue]));
    expect(stats["system"]!.droppedFrames).toBe(3);
    expect(stats["mic"]!.droppedFrames).toBe(0);
    expect(stats["mic"]!.size).toBe(2);

    // WS recovers: each source drains its own buffered frames, mic intact.
    sup.rejectFrames = false;
    orch.enqueueFrame(makeFrame(MEETING, "mic", 99)); // triggers mic drain
    expect(orch.stats(MEETING).find((s) => s.source === "mic")!.queue.size).toBe(0);
    // System still has its 2 retained frames buffered until its own next frame.
    expect(orch.stats(MEETING).find((s) => s.source === "system")!.queue.size).toBe(2);
  });

  it("buffers under disconnect then forwards on recovery (best-effort)", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup, queueCapacity: 10 });
    orch.start({ meetingId: MEETING, source: "mic" });

    sup.rejectFrames = true;
    for (let i = 0; i < 4; i++) orch.enqueueFrame(makeFrame(MEETING, "mic", i));
    expect(sup.framesSent).toHaveLength(0);
    const stat = orch.stats(MEETING).find((s) => s.source === "mic")!.queue;
    expect(stat.size).toBe(4);

    // Recover: the next enqueue drains the backlog + the new frame, in order.
    sup.rejectFrames = false;
    orch.enqueueFrame(makeFrame(MEETING, "mic", 4));
    expect(sup.framesSent).toHaveLength(5);
    expect(orch.stats(MEETING).find((s) => s.source === "mic")!.queue.size).toBe(0);
  });

  it("flushes buffered frames before sending audioStop", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup, queueCapacity: 10 });
    orch.start({ meetingId: MEETING, source: "mic" });

    sup.rejectFrames = true;
    for (let i = 0; i < 3; i++) orch.enqueueFrame(makeFrame(MEETING, "mic", i));
    expect(sup.framesSent).toHaveLength(0);

    // Stop while WS is healthy again -> flush the 3 buffered frames, THEN stop.
    sup.rejectFrames = false;
    orch.stop({ meetingId: MEETING, source: "mic" });
    expect(sup.framesSent).toHaveLength(3);
    // The last control event is the stop (frames flushed before it).
    expect(events(sup).at(-1)).toBe(AUDIO_EVENT.stop);
  });
});

describe("CaptureOrchestrator stopAll", () => {
  it("sends audioStop for every started source and clears active", () => {
    const sup = new FakeSupervisor();
    const orch = new CaptureOrchestrator({ supervisor: sup });
    orch.start({ meetingId: MEETING, source: "mic" });
    orch.start({ meetingId: MEETING, source: "system" });

    orch.stopAll();
    const stops = sup.notifications.filter((n) => n.event === AUDIO_EVENT.stop);
    expect(stops).toHaveLength(2);
    expect(sup.getActiveMeeting()).toBeNull();
    expect(orch.startedSources(MEETING)).toEqual([]);
  });
});
