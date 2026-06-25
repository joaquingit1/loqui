/**
 * Pure meeting-lifecycle model tests (node env). No React, no bridge — exercises
 * the phase machine + status-event folding in isolation.
 */
import { describe, expect, it } from "vitest";
import type { Meeting, MeetingStatus } from "@loqui/shared";
import {
  applyStatusEvent,
  canStart,
  canStop,
  initialMeetingState,
  isRecordingPhase,
  phaseFromStatus,
  type MeetingControllerState,
} from "./model.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: ID_A,
    title: "",
    platform: null,
    startedAt: "2026-06-23T10:00:00.000Z",
    endedAt: null,
    status: "recording",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    createdAt: "2026-06-23T10:00:00.000Z",
    updatedAt: "2026-06-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("phaseFromStatus", () => {
  const cases: Array<[MeetingStatus, string]> = [
    ["recording", "recording"],
    ["processing", "processing"],
    ["done", "done"],
    ["error", "error"],
  ];
  it.each(cases)("maps %s → %s", (status, phase) => {
    expect(phaseFromStatus(status)).toBe(phase);
  });
});

describe("canStart / canStop / isRecordingPhase", () => {
  it("Start is available only when idle/done/error", () => {
    expect(canStart("idle")).toBe(true);
    expect(canStart("done")).toBe(true);
    expect(canStart("error")).toBe(true);
    expect(canStart("recording")).toBe(false);
    expect(canStart("starting")).toBe(false);
    expect(canStart("stopping")).toBe(false);
    expect(canStart("processing")).toBe(false);
  });
  it("Stop is available only while recording", () => {
    expect(canStop("recording")).toBe(true);
    expect(canStop("idle")).toBe(false);
    expect(canStop("processing")).toBe(false);
  });
  it("isRecordingPhase is true only for recording", () => {
    expect(isRecordingPhase("recording")).toBe(true);
    expect(isRecordingPhase("processing")).toBe(false);
  });
});

describe("applyStatusEvent", () => {
  it("adopts a recording meeting into the recording phase", () => {
    const next = applyStatusEvent(initialMeetingState, meeting({ status: "recording" }));
    expect(next.phase).toBe("recording");
    expect(next.meeting?.id).toBe(ID_A);
    expect(next.error).toBeNull();
  });

  it("transitions recording → processing → done as the server reports", () => {
    let s: MeetingControllerState = applyStatusEvent(
      initialMeetingState,
      meeting({ status: "recording" }),
    );
    s = applyStatusEvent(s, meeting({ status: "processing" }));
    expect(s.phase).toBe("processing");
    s = applyStatusEvent(s, meeting({ status: "done", endedAt: "2026-06-23T10:05:00.000Z" }));
    expect(s.phase).toBe("done");
    expect(s.meeting?.endedAt).toBe("2026-06-23T10:05:00.000Z");
  });

  it("ignores a status event for a DIFFERENT meeting", () => {
    const tracking = applyStatusEvent(initialMeetingState, meeting({ id: ID_A }));
    const next = applyStatusEvent(tracking, meeting({ id: ID_B, status: "done" }));
    expect(next).toBe(tracking); // unchanged reference
    expect(next.phase).toBe("recording");
  });

  it("preserves a local 'stopping' phase against a racing 'recording' echo", () => {
    const base: MeetingControllerState = {
      phase: "stopping",
      meeting: meeting({ status: "recording" }),
      error: null,
    };
    const next = applyStatusEvent(base, meeting({ status: "recording" }));
    expect(next.phase).toBe("stopping");
  });

  it("surfaces an error status as the error phase", () => {
    const tracking = applyStatusEvent(initialMeetingState, meeting({ id: ID_A }));
    const next = applyStatusEvent(tracking, meeting({ id: ID_A, status: "error" }));
    expect(next.phase).toBe("error");
    expect(next.error).toBeTruthy();
  });
});
