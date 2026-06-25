/**
 * Capture controller orchestration/teardown tests (jsdom). HERMETIC: no real
 * getUserMedia / AudioWorklet / AudioContext — the entire Web-Audio + media
 * surface (CaptureEnv) and the window.loqui.audio bridge are faked. We assert
 * the control-frame ordering, frame routing, independence of the two sources,
 * and that stop() releases every resource (no leaks across start→stop→start).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoquiAudioApi } from "@loqui/shared";
import { createCaptureController, type CaptureEnv } from "./controller.js";

/** A fake MediaStreamTrack recording stop() + 'ended' listeners. */
class FakeTrack {
  stopped = false;
  private endedCbs: Array<() => void> = [];
  constructor(public kind: "audio" | "video") {}
  stop(): void {
    this.stopped = true;
  }
  addEventListener(name: string, cb: () => void): void {
    if (name === "ended") this.endedCbs.push(cb);
  }
  end(): void {
    for (const cb of this.endedCbs) cb();
  }
}

/** A fake MediaStream with audio/video tracks. */
class FakeStream {
  removed: FakeTrack[] = [];
  constructor(
    private audio: FakeTrack[],
    private video: FakeTrack[] = [],
  ) {}
  getAudioTracks(): FakeTrack[] {
    return this.audio;
  }
  getVideoTracks(): FakeTrack[] {
    return this.video;
  }
  getTracks(): FakeTrack[] {
    return [...this.audio, ...this.video];
  }
  removeTrack(t: FakeTrack): void {
    this.removed.push(t);
    this.video = this.video.filter((x) => x !== t);
    this.audio = this.audio.filter((x) => x !== t);
  }
}

class FakePort {
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

class FakeWorkletNode {
  port = new FakePort();
  disconnected = false;
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeAnalyser {
  fftSize = 1024;
  disconnected = false;
  getFloatTimeDomainData(buf: Float32Array): void {
    buf.fill(0.5); // constant peak so the meter has something to read
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeSourceNode {
  connections = 0;
  disconnected = false;
  connect(): void {
    this.connections += 1;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeContext {
  closed = false;
  addModuleUrls: Array<string | URL> = [];
  audioWorklet = {
    addModule: vi.fn(async (url: string | URL) => {
      this.addModuleUrls.push(url);
    }),
  };
  sourceNode = new FakeSourceNode();
  analyser = new FakeAnalyser();
  createMediaStreamSource(): FakeSourceNode {
    return this.sourceNode;
  }
  createAnalyser(): FakeAnalyser {
    return this.analyser;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Harness {
  contexts: FakeContext[];
  workletNodes: FakeWorkletNode[];
  micStream: FakeStream;
  systemStream: FakeStream;
  env: CaptureEnv;
  audio: LoquiAudioApi & {
    startCapture: ReturnType<typeof vi.fn>;
    stopCapture: ReturnType<typeof vi.fn>;
    sendFrame: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  opts: { startResult?: { ok: boolean; code?: string; message?: string } } = {},
): Harness {
  const contexts: FakeContext[] = [];
  const workletNodes: FakeWorkletNode[] = [];
  const micStream = new FakeStream([new FakeTrack("audio")]);
  const systemStream = new FakeStream([new FakeTrack("audio")], [new FakeTrack("video")]);

  const audio = {
    startCapture: vi.fn(async () => opts.startResult ?? { ok: true }),
    stopCapture: vi.fn(async () => ({ ok: true })),
    sendFrame: vi.fn(),
    getScreenPermission: vi.fn(async () => "not-applicable" as const),
    onScreenPermission: vi.fn(() => () => {}),
  };

  const env: CaptureEnv = {
    getUserMedia: vi.fn(async () => micStream as unknown as MediaStream),
    getDisplayMedia: vi.fn(async () => systemStream as unknown as MediaStream),
    createAudioContext: () => {
      const c = new FakeContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    createWorkletNode: () => {
      const n = new FakeWorkletNode();
      workletNodes.push(n);
      return n as unknown as AudioWorkletNode;
    },
    workletModuleUrl: () => "blob:fake-worklet",
    requestAnimationFrame: () => 0, // no auto-loop; meter ticks are driven manually
    cancelAnimationFrame: vi.fn(),
  };

  return {
    contexts,
    workletNodes,
    micStream,
    systemStream,
    env,
    audio: audio as Harness["audio"],
  };
}

const MEETING = "11111111-2222-3333-4444-555555555555";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCaptureController", () => {
  it("starts the mic: bridge startCapture, getUserMedia, worklet module loaded", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");

    expect(h.audio.startCapture).toHaveBeenCalledWith({
      meetingId: MEETING,
      source: "mic",
    });
    expect(h.env.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.env.getDisplayMedia).not.toHaveBeenCalled();
    expect(h.contexts[0]!.addModuleUrls).toEqual(["blob:fake-worklet"]);
    expect(c.getStatus("mic").state).toBe("capturing");
    // source node fanned out to BOTH the analyser and the worklet (2 connects).
    expect(h.contexts[0]!.sourceNode.connections).toBe(2);
  });

  it("system source keeps only the audio track and stops/removes the video track", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("system");

    expect(h.env.getDisplayMedia).toHaveBeenCalledTimes(1);
    const video = h.systemStream.getVideoTracks(); // emptied after removeTrack
    expect(video.length).toBe(0);
    expect(h.systemStream.removed.some((t) => t.kind === "video" && t.stopped)).toBe(
      true,
    );
    expect(c.getStatus("system").state).toBe("capturing");
  });

  it("routes worklet frame buffers to the bridge sendFrame, tagged per-source", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    const frame = new Uint8Array([0xa0, 0, 0, 0]).buffer;
    h.workletNodes[0]!.port.emit(frame);

    expect(h.audio.sendFrame).toHaveBeenCalledWith({
      meetingId: MEETING,
      source: "mic",
      frame,
    });
    // empty / non-ArrayBuffer payloads are ignored.
    h.workletNodes[0]!.port.emit(new ArrayBuffer(0));
    h.workletNodes[0]!.port.emit("garbage");
    expect(h.audio.sendFrame).toHaveBeenCalledTimes(1);
  });

  it("mute drops a source's frames + zeroes its meter; the other source is untouched (PRD-13)", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    await c.start("system");
    const frame = new Uint8Array([0xa0, 0, 0, 0]).buffer;

    // Unmuted: frames flow.
    h.workletNodes[0]!.port.emit(frame);
    expect(h.audio.sendFrame).toHaveBeenCalledTimes(1);

    // Mute the mic: its frames are dropped; system still flows.
    const muted = c.toggleMute("mic");
    expect(muted).toBe(true);
    expect(c.getStatus("mic").muted).toBe(true);
    expect(c.getStatus("system").muted).toBe(false);
    h.workletNodes[0]!.port.emit(frame); // mic frame dropped
    h.workletNodes[1]!.port.emit(frame); // system frame forwarded
    expect(h.audio.sendFrame).toHaveBeenCalledTimes(2);
    expect(h.audio.sendFrame).toHaveBeenLastCalledWith({
      meetingId: MEETING,
      source: "system",
      frame,
    });

    // Unmute the mic: frames flow again.
    c.setMuted("mic", false);
    expect(c.getStatus("mic").muted).toBe(false);
    h.workletNodes[0]!.port.emit(frame);
    expect(h.audio.sendFrame).toHaveBeenCalledTimes(3);
  });

  it("runs the two sources independently (separate contexts + nodes)", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    await c.start("system");

    expect(h.contexts.length).toBe(2);
    expect(h.workletNodes.length).toBe(2);
    expect(c.getStatus("mic").state).toBe("capturing");
    expect(c.getStatus("system").state).toBe("capturing");
  });

  it("stop() releases every resource and sends audioStop", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    const ctx = h.contexts[0]!;
    const node = h.workletNodes[0]!;
    await c.stop("mic");

    expect(ctx.closed).toBe(true);
    expect(node.port.closed).toBe(true);
    expect(node.disconnected).toBe(true);
    expect(ctx.sourceNode.disconnected).toBe(true);
    expect(ctx.analyser.disconnected).toBe(true);
    expect(h.micStream.getAudioTracks()[0]!.stopped).toBe(true);
    expect(h.audio.stopCapture).toHaveBeenCalledWith({
      meetingId: MEETING,
      source: "mic",
    });
    expect(c.getStatus("mic").state).toBe("idle");
  });

  it("start → stop → start works again without leaking (fresh context)", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    await c.stop("mic");
    await c.start("mic");

    expect(h.contexts.length).toBe(2); // a second, fresh context
    expect(c.getStatus("mic").state).toBe("capturing");
  });

  it("re-entry while capturing is a no-op", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    await c.start("mic");
    expect(h.audio.startCapture).toHaveBeenCalledTimes(1);
    expect(h.contexts.length).toBe(1);
  });

  it("surfaces a bridge refusal (e.g. permission denied) as error state", async () => {
    const hh = makeHarness({
      startResult: { ok: false, code: "screen_permission_denied", message: "denied" },
    });
    const c = createCaptureController({
      audio: hh.audio,
      meetingId: MEETING,
      env: hh.env,
    });
    await c.start("system");
    expect(c.getStatus("system").state).toBe("error");
    expect(c.getStatus("system").error).toContain("denied");
    expect(hh.env.getDisplayMedia).not.toHaveBeenCalled();
  });

  it("tears down + reports error when device acquisition throws, then tells main to stop", async () => {
    h.env.getUserMedia = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    expect(c.getStatus("mic").state).toBe("error");
    expect(c.getStatus("mic").error).toContain("NotAllowedError");
    // main was told to start, so we roll it back with a stop.
    expect(h.audio.stopCapture).toHaveBeenCalledWith({
      meetingId: MEETING,
      source: "mic",
    });
  });

  it("a track 'ended' event auto-stops that source", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    h.micStream.getAudioTracks()[0]!.end();
    // stop() is async (closes the context, awaits the bridge); flush microtasks
    // until it settles to idle.
    await vi.waitFor(() => expect(c.getStatus("mic").state).toBe("idle"));
  });

  it("emits status updates to subscribers", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    const seen: string[] = [];
    c.subscribe((source, status) => seen.push(`${source}:${status.state}`));
    await c.start("mic");
    expect(seen).toContain("mic:starting");
    expect(seen).toContain("mic:capturing");
  });

  it("stopAll stops every active source", async () => {
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    await c.start("system");
    await c.stopAll();
    expect(c.getStatus("mic").state).toBe("idle");
    expect(c.getStatus("system").state).toBe("idle");
    expect(h.audio.stopCapture).toHaveBeenCalledTimes(2);
  });

  it("drives the level meter from the analyser peak", async () => {
    // Provide a one-shot rAF so the meter ticks exactly once.
    const captured: FrameRequestCallback[] = [];
    h.env.requestAnimationFrame = (fn) => {
      captured.push(fn);
      return 1;
    };
    const c = createCaptureController({ audio: h.audio, meetingId: MEETING, env: h.env });
    await c.start("mic");
    captured[0]?.(0); // run the meter tick: analyser fills 0.5
    expect(c.getStatus("mic").level).toBeCloseTo(0.5, 5);
  });
});
