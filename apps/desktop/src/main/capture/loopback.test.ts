import { describe, expect, it, vi } from "vitest";
import type { DesktopCapturerSource } from "electron";
import {
  type DisplayMediaStreams,
  type LoopbackSession,
  makeDisplayMediaLoopbackHandler,
  registerDisplayMediaLoopback,
} from "./loopback.js";

describe("makeDisplayMediaLoopbackHandler", () => {
  it("enables loopback audio and no video source by default", () => {
    const handler = makeDisplayMediaLoopbackHandler();
    let got: DisplayMediaStreams | undefined;
    handler({}, (streams) => {
      got = streams;
    });
    expect(got).toEqual({ audio: "loopback" });
    expect(got?.video).toBeUndefined();
  });

  it("uses loopbackWithMute when muteLocalPlayback is set", () => {
    const handler = makeDisplayMediaLoopbackHandler({ muteLocalPlayback: true });
    let got: DisplayMediaStreams | undefined;
    handler({}, (s) => {
      got = s;
    });
    expect(got?.audio).toBe("loopbackWithMute");
  });

  it("attaches a resolved video source when provided", () => {
    const fakeSource = { id: "screen:0", name: "Primary" } as unknown as DesktopCapturerSource;
    const resolveVideoSource = vi.fn(() => fakeSource);
    const handler = makeDisplayMediaLoopbackHandler({ resolveVideoSource });
    let got: DisplayMediaStreams | undefined;
    handler({}, (s) => {
      got = s;
    });
    expect(resolveVideoSource).toHaveBeenCalledOnce();
    expect(got).toEqual({ audio: "loopback", video: fakeSource });
  });

  it("omits video when the resolver returns undefined", () => {
    const handler = makeDisplayMediaLoopbackHandler({ resolveVideoSource: () => undefined });
    let got: DisplayMediaStreams | undefined;
    handler({}, (s) => {
      got = s;
    });
    expect(got).toEqual({ audio: "loopback" });
  });
});

describe("registerDisplayMediaLoopback", () => {
  it("registers a handler with useSystemPicker:false and the disposer clears it", () => {
    const calls: unknown[][] = [];
    const session: LoopbackSession = {
      setDisplayMediaRequestHandler: (handler, opts) => {
        calls.push([handler, opts]);
      },
    };
    const dispose = registerDisplayMediaLoopback(session);
    expect(calls).toHaveLength(1);
    const [handler, opts] = calls[0]!;
    expect(typeof handler).toBe("function");
    expect(opts).toEqual({ useSystemPicker: false });

    dispose();
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBeNull();
  });

  it("the registered handler enables loopback audio", () => {
    let registered:
      | ((request: unknown, cb: (s: DisplayMediaStreams) => void) => void)
      | null = null;
    const session: LoopbackSession = {
      setDisplayMediaRequestHandler: (handler) => {
        registered = handler as typeof registered;
      },
    };
    registerDisplayMediaLoopback(session);
    let got: DisplayMediaStreams | undefined;
    registered!({}, (s) => {
      got = s;
    });
    expect(got?.audio).toBe("loopback");
  });
});
