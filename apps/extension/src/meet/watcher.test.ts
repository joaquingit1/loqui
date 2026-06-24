/**
 * PRD-6 — watcher diff/gate tests (PURE logic, no browser).
 *
 * Drives createMeetWatcher with a fake selectors object + fake sender + manual
 * clock. Asserts: one `activity` per toggle; the contract event shape; `null`
 * (unreadable indicator) holds state (no churn); a vanished speaker closes its
 * turn; a null root closes open turns + goes quiet; nothing emits before start
 * or after stop; a thrown selector read never propagates.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionMessage } from "@loqui/shared";
import { speakerActivityEventSchema } from "@loqui/shared";
import { createMeetWatcher } from "./watcher.js";
import { diffSpeaking, mergeSpeakingState } from "./watcher.js";
import type { MeetParticipantReading, MeetSelectors } from "./selectors.js";
import type { MeetEventSender } from "../ws-client.js";

function fakeSender() {
  const sent: ExtensionMessage[] = [];
  const sender: MeetEventSender = {
    send: (m) => void sent.push(m),
    close: vi.fn(),
  };
  return { sender, sent };
}

function activityFrames(sent: ExtensionMessage[]) {
  return sent
    .filter((m): m is Extract<ExtensionMessage, { type: "activity" }> => m.type === "activity")
    .map((m) => m.event);
}

describe("createMeetWatcher — toggles", () => {
  it("emits one activity per speaking toggle (start, then stop)", () => {
    const { sender, sent } = fakeSender();
    let tickNo = 0;
    const readings: MeetParticipantReading[][] = [
      [{ name: "Alex", speaking: true }],
      [{ name: "Alex", speaking: true }], // unchanged => no new event
      [{ name: "Alex", speaking: false }],
    ];
    const sel: MeetSelectors = {
      version: "t",
      listParticipants: () => [],
      readActiveSpeakers: () => readings[Math.min(tickNo, readings.length - 1)] ?? [],
    };
    let clock = 1000;
    const w = createMeetWatcher({
      selectors: sel,
      sender,
      getRoot: () => ({}) as ParentNode,
      now: () => clock,
    });
    w.start();
    w.tick();
    tickNo = 1;
    clock = 1500;
    w.tick();
    tickNo = 2;
    clock = 2000;
    w.tick();

    const evs = activityFrames(sent);
    expect(evs).toEqual([
      { ts: 1000, name: "Alex", speaking: true },
      { ts: 2000, name: "Alex", speaking: false },
    ]);
  });

  it("emitted events satisfy the shared SpeakerActivityEvent contract", () => {
    const { sender, sent } = fakeSender();
    const readings = [[{ name: "Jordan", speaking: true }]];
    const w = createMeetWatcher({
      selectors: {
        version: "t",
        listParticipants: () => [],
        readActiveSpeakers: () => readings[0] ?? [],
      },
      sender,
      getRoot: () => ({}) as ParentNode,
      now: () => 4242,
    });
    w.start();
    w.tick();
    const evs = activityFrames(sent);
    expect(evs).toHaveLength(1);
    // Round-trips through the shared zod schema without loss.
    expect(speakerActivityEventSchema.parse(evs[0])).toEqual({
      ts: 4242,
      name: "Jordan",
      speaking: true,
    });
  });

  it("holds state on a null (unreadable) indicator — no spurious stop/start", () => {
    const { sender, sent } = fakeSender();
    let frame = 0;
    const readings: MeetParticipantReading[][] = [
      [{ name: "Alex", speaking: true }],
      [{ name: "Alex", speaking: null }], // unreadable this tick
      [{ name: "Alex", speaking: true }],
    ];
    const w = createMeetWatcher({
      selectors: {
        version: "t",
        listParticipants: () => [],
        readActiveSpeakers: () => readings[frame] ?? [],
      },
      sender,
      getRoot: () => ({}) as ParentNode,
      now: () => frame,
    });
    w.start();
    w.tick();
    frame = 1;
    w.tick();
    frame = 2;
    w.tick();
    // Only the initial start should have emitted — null held the speaking state.
    expect(activityFrames(sent)).toEqual([{ ts: 0, name: "Alex", speaking: true }]);
  });

  it("closes the turn of a speaker who disappears from the reading", () => {
    const { sender, sent } = fakeSender();
    let frame = 0;
    const readings: MeetParticipantReading[][] = [
      [{ name: "Alex", speaking: true }],
      [], // Alex gone
    ];
    const w = createMeetWatcher({
      selectors: {
        version: "t",
        listParticipants: () => [],
        readActiveSpeakers: () => readings[frame] ?? [],
      },
      sender,
      getRoot: () => ({}) as ParentNode,
      now: () => frame,
    });
    w.start();
    w.tick();
    frame = 1;
    w.tick();
    expect(activityFrames(sent)).toEqual([
      { ts: 0, name: "Alex", speaking: true },
      { ts: 1, name: "Alex", speaking: false },
    ]);
  });

  it("a null root closes open turns and goes quiet", () => {
    const { sender, sent } = fakeSender();
    let root: ParentNode | null = {} as ParentNode;
    const w = createMeetWatcher({
      selectors: {
        version: "t",
        listParticipants: () => [],
        readActiveSpeakers: () => [{ name: "Alex", speaking: true }],
      },
      sender,
      getRoot: () => root,
      now: () => 7,
    });
    w.start();
    w.tick(); // speaking:true
    root = null;
    w.tick(); // root gone => close turn
    w.tick(); // nothing more
    expect(activityFrames(sent)).toEqual([
      { ts: 7, name: "Alex", speaking: true },
      { ts: 7, name: "Alex", speaking: false },
    ]);
  });
});

describe("createMeetWatcher — gating", () => {
  it("emits nothing before start() or after stop()", () => {
    const { sender, sent } = fakeSender();
    const w = createMeetWatcher({
      selectors: {
        version: "t",
        listParticipants: () => [],
        readActiveSpeakers: () => [{ name: "Alex", speaking: true }],
      },
      sender,
      getRoot: () => ({}) as ParentNode,
      now: () => 1,
    });
    w.tick(); // before start
    expect(sent).toHaveLength(0);
    w.start();
    w.tick();
    expect(activityFrames(sent)).toHaveLength(1);
    w.stop();
    w.tick();
    expect(activityFrames(sent)).toHaveLength(1); // unchanged after stop
  });

  it("never throws when the selector read throws (#1 invariant)", () => {
    const { sender } = fakeSender();
    const w = createMeetWatcher({
      selectors: {
        version: "t",
        listParticipants: () => [],
        readActiveSpeakers: () => {
          throw new Error("DOM exploded");
        },
      },
      sender,
      getRoot: () => ({}) as ParentNode,
      now: () => 1,
    });
    w.start();
    expect(() => w.tick()).not.toThrow();
  });
});

describe("diffSpeaking / mergeSpeakingState (pure)", () => {
  it("diff: detects starts, stops, holds nulls, closes vanished", () => {
    const prev = new Map<string, boolean | null>([
      ["A", true],
      ["B", false],
      ["C", true],
    ]);
    const curr = new Map<string, boolean | null>([
      ["A", true], // unchanged
      ["B", true], // started
      // C vanished while speaking => stop
      ["D", null], // unknown => ignored
    ]);
    expect(diffSpeaking(prev, curr)).toEqual([
      { name: "B", speaking: true },
      { name: "C", speaking: false },
    ]);
  });

  it("merge: a null holds the prior value; new null defaults to false", () => {
    const prev = new Map<string, boolean | null>([["A", true]]);
    const curr = new Map<string, boolean | null>([
      ["A", null],
      ["B", null],
      ["C", false],
    ]);
    const next = mergeSpeakingState(prev, curr);
    expect(next.get("A")).toBe(true);
    expect(next.get("B")).toBe(false);
    expect(next.get("C")).toBe(false);
  });
});
