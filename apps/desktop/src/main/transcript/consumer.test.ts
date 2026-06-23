/**
 * Hermetic tests for the final-segment consumer (PRD-3): it subscribes to the
 * supervisor's transcript notification fan-out and routes ONLY confirmed
 * (`final`) segments to both the (append-only) writer and the FTS index, drops
 * partials + malformed payloads, and never throws into the fan-out loop.
 */
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_SEGMENT_EVENT, type TranscriptSegment } from "@loqui/shared";
import {
  consumeFinalTranscriptSegments,
  persistFinalSegment,
  type TranscriptIndexStore,
} from "./consumer.js";
import type { TranscriptWriter } from "./writer.js";

const MID = "11111111-1111-4111-8111-111111111111";

function seg(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    meetingId: MID,
    source: "mic",
    text: "hi",
    tStart: 0,
    tEnd: 1,
    status: "final",
    segId: "s1",
    ...over,
  };
}

/** Fake supervisor exposing the onNotification fan-out the consumer needs. */
function makeSupervisor() {
  const listeners = new Set<(event: string, data: unknown) => void>();
  return {
    onNotification: (cb: (event: string, data: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (event: string, data: unknown) => {
      for (const l of listeners) l(event, data);
    },
  };
}

describe("persistFinalSegment", () => {
  it("writes + indexes a final segment", () => {
    const writer: TranscriptWriter = { appendConfirmedSegment: vi.fn(() => true) };
    const store: TranscriptIndexStore = { appendTranscriptSegment: vi.fn() };
    persistFinalSegment(seg(), writer, store);
    expect(writer.appendConfirmedSegment).toHaveBeenCalledTimes(1);
    expect(store.appendTranscriptSegment).toHaveBeenCalledWith(MID, "s1", "hi");
  });

  it("ignores a partial segment", () => {
    const writer: TranscriptWriter = { appendConfirmedSegment: vi.fn(() => true) };
    const store: TranscriptIndexStore = { appendTranscriptSegment: vi.fn() };
    persistFinalSegment(seg({ status: "partial" }), writer, store);
    expect(writer.appendConfirmedSegment).not.toHaveBeenCalled();
    expect(store.appendTranscriptSegment).not.toHaveBeenCalled();
  });

  it("still appends the file even if the index throws", () => {
    const writer: TranscriptWriter = { appendConfirmedSegment: vi.fn(() => true) };
    const store: TranscriptIndexStore = {
      appendTranscriptSegment: vi.fn(() => {
        throw new Error("db locked");
      }),
    };
    expect(() => persistFinalSegment(seg(), writer, store)).not.toThrow();
    expect(writer.appendConfirmedSegment).toHaveBeenCalledTimes(1);
  });
});

describe("consumeFinalTranscriptSegments", () => {
  it("routes only final transcriptSegment notifications; drops partials/other events/malformed", () => {
    const sup = makeSupervisor();
    const writer: TranscriptWriter = { appendConfirmedSegment: vi.fn(() => true) };
    const store: TranscriptIndexStore = { appendTranscriptSegment: vi.fn() };
    const dispose = consumeFinalTranscriptSegments({ supervisor: sup, writer, store });

    sup.emit(TRANSCRIPT_SEGMENT_EVENT, seg({ segId: "f1" }));
    sup.emit(TRANSCRIPT_SEGMENT_EVENT, seg({ segId: "p1", status: "partial" }));
    sup.emit("jobUpdate", { jobId: "j", kind: "summary" });
    sup.emit(TRANSCRIPT_SEGMENT_EVENT, { not: "a segment" });

    expect(writer.appendConfirmedSegment).toHaveBeenCalledTimes(1);
    expect(store.appendTranscriptSegment).toHaveBeenCalledTimes(1);
    expect(store.appendTranscriptSegment).toHaveBeenCalledWith(MID, "f1", "hi");

    dispose();
    sup.emit(TRANSCRIPT_SEGMENT_EVENT, seg({ segId: "f2" }));
    expect(writer.appendConfirmedSegment).toHaveBeenCalledTimes(1);
  });
});
