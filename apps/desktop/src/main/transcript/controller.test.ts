/**
 * Hermetic tests for the MeetingController lifecycle state machine (PRD-3).
 *
 * Pins LOQUI_DATA_DIR at a temp dir and drives a REAL store (openStore) so the
 * transitions, the persisted meta.json, and the index row are all exercised end
 * to end — including survive-restart (reopen the store + re-read the meeting). A
 * fake supervisor asserts the active-meeting routing pointer is set on start and
 * cleared on stop. A frozen clock makes startedAt/endedAt deterministic.
 *
 * Covered invariants:
 *   - start: create -> recording, startedAt set, supervisor.setActiveMeeting(id)
 *   - only one recording at a time (second start throws)
 *   - stop: recording -> processing -> done, endedAt set, active cleared
 *   - stop is idempotent (double-stop is a no-op returning the done meeting)
 *   - stop of an unknown id throws
 *   - status listeners receive recording, processing, done in order
 *   - meeting + status survive an app restart (reopen store, re-read)
 *   - getActiveMeeting reflects the live recording meeting / null
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV, type Meeting } from "@loqui/shared";
import { openStore, type MeetingStore } from "../store/index.js";
import {
  createMeetingController,
  type MeetingLifecycleSupervisor,
} from "./controller.js";

let tmp: string;
let store: MeetingStore;

/** Fake supervisor recording every setActiveMeeting call. */
function makeSupervisor() {
  const calls: Array<string | null> = [];
  const sup: MeetingLifecycleSupervisor = {
    setActiveMeeting: (id) => {
      calls.push(id);
    },
  };
  return { sup, calls };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-controller-"));
  process.env[DATA_DIR_ENV] = tmp;
  store = openStore();
});

afterEach(() => {
  store.close();
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("MeetingController.startMeeting", () => {
  it("creates a recording meeting with startedAt and marks it active", async () => {
    const { sup, calls } = makeSupervisor();
    const controller = createMeetingController({
      store,
      supervisor: sup,
      now: () => "2026-06-23T10:00:00.000Z",
    });

    const m = await controller.startMeeting({ title: "Standup", platform: "zoom" });

    expect(m.status).toBe("recording");
    expect(m.startedAt).toBe("2026-06-23T10:00:00.000Z");
    expect(m.endedAt).toBeNull();
    expect(m.title).toBe("Standup");
    expect(m.platform).toBe("zoom");
    // Routed to the supervisor so audio/transcript target this id.
    expect(calls).toEqual([m.id]);
    // Persisted to meta.json (read straight back from the store).
    expect(store.getMeeting(m.id)?.status).toBe("recording");
    expect(controller.getActiveMeeting()?.id).toBe(m.id);
  });

  it("defaults title/platform when no params are given", async () => {
    const controller = createMeetingController({ store });
    const m = await controller.startMeeting();
    expect(m.status).toBe("recording");
    expect(m.title).toBe("");
    expect(m.platform).toBeNull();
  });

  it("rejects a second start while one meeting is still recording", async () => {
    const { sup, calls } = makeSupervisor();
    const controller = createMeetingController({ store, supervisor: sup });
    const first = await controller.startMeeting();
    await expect(controller.startMeeting()).rejects.toThrow(/still recording/);
    // No second meeting was created and the active pointer is unchanged.
    expect(controller.getActiveMeeting()?.id).toBe(first.id);
    expect(calls).toEqual([first.id]);
  });

  it("works without a supervisor (headless)", async () => {
    const controller = createMeetingController({ store });
    const m = await controller.startMeeting();
    expect(m.status).toBe("recording");
    expect(controller.getActiveMeeting()?.id).toBe(m.id);
  });
});

describe("MeetingController.stopMeeting", () => {
  it("transitions recording -> processing -> done, sets endedAt, clears active", async () => {
    const { sup, calls } = makeSupervisor();
    const now = vi
      .fn<() => string>()
      .mockReturnValueOnce("2026-06-23T10:00:00.000Z") // start
      .mockReturnValue("2026-06-23T10:05:00.000Z"); // stop (processing + done)
    const controller = createMeetingController({ store, supervisor: sup, now });

    const started = await controller.startMeeting();
    const done = await controller.stopMeeting({ id: started.id });

    expect(done.status).toBe("done");
    expect(done.endedAt).toBe("2026-06-23T10:05:00.000Z");
    expect(done.startedAt).toBe("2026-06-23T10:00:00.000Z");
    // Active set on start, cleared on stop.
    expect(calls).toEqual([started.id, null]);
    expect(controller.getActiveMeeting()).toBeNull();
    expect(store.getMeeting(started.id)?.status).toBe("done");
  });

  it("emits recording, processing, then done in order", async () => {
    const controller = createMeetingController({ store });
    const seen: Array<Meeting["status"]> = [];
    controller.onMeetingStatus((m) => seen.push(m.status));

    const started = await controller.startMeeting();
    await controller.stopMeeting({ id: started.id });

    expect(seen).toEqual(["recording", "processing", "done"]);
  });

  it("is idempotent: a second stop is a no-op returning the done meeting", async () => {
    const controller = createMeetingController({ store });
    const started = await controller.startMeeting();
    await controller.stopMeeting({ id: started.id });

    const seen: Array<Meeting["status"]> = [];
    controller.onMeetingStatus((m) => seen.push(m.status));
    const again = await controller.stopMeeting({ id: started.id });

    expect(again.status).toBe("done");
    // No transitions re-emitted on the redundant stop.
    expect(seen).toEqual([]);
    expect(controller.getActiveMeeting()).toBeNull();
  });

  it("throws when stopping an unknown meeting id", async () => {
    const controller = createMeetingController({ store });
    await expect(
      controller.stopMeeting({ id: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/unknown meeting/);
  });

  it("flips to error and re-throws when finalize fails", async () => {
    // Wrap the store so the 'done' update throws once, after 'processing'.
    const real = store;
    const seen: Array<Meeting["status"]> = [];
    const failing = {
      createMeeting: real.createMeeting.bind(real),
      getMeeting: real.getMeeting.bind(real),
      updateMeeting: (id: string, patch: Parameters<MeetingStore["updateMeeting"]>[1]) => {
        if (patch.status === "done") throw new Error("finalize boom");
        return real.updateMeeting(id, patch);
      },
    };
    const controller = createMeetingController({ store: failing });
    controller.onMeetingStatus((m) => seen.push(m.status));

    const started = await controller.startMeeting();
    await expect(controller.stopMeeting({ id: started.id })).rejects.toThrow(
      /finalize boom/,
    );
    // recording -> processing -> (done fails) -> error, all observed.
    expect(seen).toEqual(["recording", "processing", "error"]);
    expect(real.getMeeting(started.id)?.status).toBe("error");
  });

  it("allows starting a new meeting after the previous one is stopped", async () => {
    const { sup, calls } = makeSupervisor();
    const controller = createMeetingController({ store, supervisor: sup });
    const first = await controller.startMeeting();
    await controller.stopMeeting({ id: first.id });
    const second = await controller.startMeeting();

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("recording");
    expect(calls).toEqual([first.id, null, second.id]);
  });
});

describe("MeetingController persistence / restart", () => {
  it("survives an app restart: the meeting + status reload from disk", async () => {
    const controller = createMeetingController({ store });
    const started = await controller.startMeeting({ title: "Survives" });
    await controller.stopMeeting({ id: started.id });
    store.close();

    // Simulate an app restart: reopen the store rooted at the SAME data dir.
    const reopened = openStore();
    try {
      const reloaded = reopened.getMeeting(started.id);
      expect(reloaded?.status).toBe("done");
      expect(reloaded?.title).toBe("Survives");
      // And it lists newest-first via the rebuilt index.
      expect(reopened.listMeetings().map((m) => m.id)).toContain(started.id);
    } finally {
      reopened.close();
    }
    // Re-open once more for the afterEach close() to operate on a live handle.
    store = openStore();
  });
});
