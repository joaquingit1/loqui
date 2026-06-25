/**
 * Hermetic tests for the speaker-name applier (PRD-6).
 *
 * Uses a temp LOQUI_DATA_DIR so the REAL postprocess diarized-file writer runs
 * (the applier REUSES that path — it imports ../postprocess/writers + render).
 * The store is a fake matching the rename path's shape. Covers:
 *   - applies resolved names (apply:true): rewrites diarized json + re-rendered
 *     md, persists meta.participants, re-indexes;
 *   - MANUAL renames ALWAYS win (a user-set name is never overwritten);
 *   - apply:false / empty result is a NO-OP (no file rewritten);
 *   - transcript.live.md + transcript.jsonl stay BYTE-IDENTICAL across a merge;
 *   - never-diarized meeting => null (keeps generic labels).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DiarizedTranscript,
  Meeting,
  SpeakerCorrelationResult,
  Summary,
} from "@loqui/shared";

const { applySpeakerNames } = await import("./apply.js");
const {
  meetingDiarizedTranscriptMdPath,
  meetingDiarizedTranscriptJsonPath,
  meetingLiveTranscriptPath,
  meetingTranscriptPath,
  meetingDir,
} = await import("../store/paths.js");
const { writeDiarizedTranscript } = await import("../postprocess/writers.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loqui-snapply-"));
  process.env.LOQUI_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.LOQUI_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function meeting(id: string, patch: Partial<Meeting> = {}): Meeting {
  const now = "2026-06-24T00:00:00.000Z";
  return {
    id,
    title: "",
    platform: "google-meet",
    startedAt: now,
    endedAt: now,
    status: "done",
    kind: "meeting",
    participants: [],
    modelVersions: {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

const baseDiarized = (id: string): DiarizedTranscript => ({
  meetingId: id,
  version: 1,
  diarized: true,
  backend: "fake",
  speakers: ["Speaker 1", "Speaker 2"],
  segments: [
    {
      segId: "s1",
      source: "mic",
      text: "Hello",
      tStart: 0,
      tEnd: 1,
      speaker: "You",
      displayName: null,
    },
    {
      segId: "s2",
      source: "system",
      text: "Hi there",
      tStart: 5,
      tEnd: 7,
      speaker: "Speaker 1",
      displayName: null,
    },
    {
      segId: "s3",
      source: "system",
      text: "Bye",
      tStart: 9,
      tEnd: 10,
      speaker: "Speaker 2",
      displayName: null,
    },
  ],
});

function makeStore(opts: {
  meetings?: Meeting[];
  summary?: Summary | null;
  diarized: DiarizedTranscript | null;
}) {
  const meetings = new Map<string, Meeting>();
  for (const m of opts.meetings ?? []) meetings.set(m.id, m);
  const indexed: Array<{ meetingId: string; summary?: string }> = [];
  return {
    indexed,
    meetings,
    getMeeting: (id: string): Meeting | null => meetings.get(id) ?? null,
    updateMeeting: (id: string, patch: Partial<Meeting>): Meeting => {
      const cur = meetings.get(id);
      if (!cur) throw new Error(`unknown ${id}`);
      const next = { ...cur, ...patch, id, updatedAt: "2026-06-24T00:00:02.000Z" };
      meetings.set(id, next);
      return next;
    },
    getSummary: (_id: string): Summary | null => opts.summary ?? null,
    getDiarizedTranscript: (_id: string): DiarizedTranscript | null => opts.diarized,
    upsertSearchText: (text: { meetingId: string; summary?: string }): void => {
      indexed.push(text);
    },
  };
}

function result(
  meetingId: string,
  resolutions: Array<Partial<SpeakerCorrelationResult["resolutions"][number]>>,
): SpeakerCorrelationResult {
  return {
    meetingId,
    resolutions: resolutions.map((r) => ({
      speaker: "",
      name: "",
      confidence: 1,
      support: 1000,
      apply: true,
      ...r,
    })),
    participants: [],
    usedActivityEvents: 1,
    coveragePct: 1,
  };
}

/** Seed a live transcript + structured jsonl so we can assert byte-identity. */
function seedLiveFiles(id: string): { live: string; jsonl: string } {
  mkdirSync(meetingDir(id), { recursive: true });
  const live = "[00:00:00] You: Hello\n[00:00:05] Speaker 1: Hi there\n";
  const jsonl = `{"segId":"s2","source":"system","text":"Hi there"}\n`;
  writeFileSync(meetingLiveTranscriptPath(id), live, "utf8");
  writeFileSync(meetingTranscriptPath(id, "structured"), jsonl, "utf8");
  return { live, jsonl };
}

describe("applySpeakerNames — applies resolved names via the rewrite path", () => {
  it("rewrites diarized json + md, persists meta.participants, re-indexes", () => {
    const d = baseDiarized("m1");
    writeDiarizedTranscript(d);
    const store = makeStore({
      diarized: d,
      meetings: [
        meeting("m1", {
          participants: [
            { id: "Speaker 1", name: "Speaker 1", speakerLabel: "Speaker 1" },
            { id: "Speaker 2", name: "Speaker 2", speakerLabel: "Speaker 2" },
          ],
        }),
      ],
    });
    const res = result("m1", [
      { speaker: "Speaker 1", name: "Alice" },
      { speaker: "Speaker 2", name: "Bob" },
    ]);

    const updated = applySpeakerNames(store, res)!;
    expect(updated.segments.find((s) => s.segId === "s2")?.displayName).toBe("Alice");
    expect(updated.segments.find((s) => s.segId === "s3")?.displayName).toBe("Bob");

    const md = readFileSync(meetingDiarizedTranscriptMdPath("m1"), "utf8");
    expect(md).toContain("Alice: Hi there");
    expect(md).toContain("Bob: Bye");
    expect(md).not.toContain("Speaker 1: Hi there");

    const json = JSON.parse(
      readFileSync(meetingDiarizedTranscriptJsonPath("m1"), "utf8"),
    ) as DiarizedTranscript;
    expect(json.segments.find((s) => s.segId === "s2")?.displayName).toBe("Alice");

    expect(
      store.getMeeting("m1")!.participants.find((p) => p.speakerLabel === "Speaker 1")
        ?.name,
    ).toBe("Alice");
    expect(
      store.getMeeting("m1")!.participants.find((p) => p.speakerLabel === "Speaker 2")
        ?.name,
    ).toBe("Bob");

    expect(store.indexed).toHaveLength(1);
    expect(store.indexed[0]!.summary).toContain("Alice: Hi there");
  });

  it("creates a participant row for a resolved label that had none", () => {
    const d = baseDiarized("mX");
    writeDiarizedTranscript(d);
    const store = makeStore({
      diarized: d,
      meetings: [meeting("mX", { participants: [] })],
    });
    applySpeakerNames(store, result("mX", [{ speaker: "Speaker 1", name: "Alice" }]));
    const p = store
      .getMeeting("mX")!
      .participants.find((x) => x.speakerLabel === "Speaker 1");
    expect(p).toEqual({ id: "Speaker 1", name: "Alice", speakerLabel: "Speaker 1" });
  });
});

describe("applySpeakerNames — MANUAL renames always win", () => {
  it("never overwrites a user-set name; applies only the un-renamed speaker", () => {
    const d = baseDiarized("m2");
    writeDiarizedTranscript(d);
    const store = makeStore({
      diarized: d,
      meetings: [
        meeting("m2", {
          participants: [
            // Speaker 1 was manually renamed to "Charlie" by the user.
            { id: "Speaker 1", name: "Charlie", speakerLabel: "Speaker 1" },
            { id: "Speaker 2", name: "Speaker 2", speakerLabel: "Speaker 2" },
          ],
        }),
      ],
    });
    // The engine resolves Speaker 1 -> "Alice" (wrong! user said Charlie) and
    // Speaker 2 -> "Bob".
    const res = result("m2", [
      { speaker: "Speaker 1", name: "Alice" },
      { speaker: "Speaker 2", name: "Bob" },
    ]);

    const updated = applySpeakerNames(store, res)!;
    // Speaker 1 keeps the manual name "Charlie" (auto-resolution did not touch it).
    expect(updated.segments.find((s) => s.segId === "s2")?.displayName).toBeNull();
    expect(
      store.getMeeting("m2")!.participants.find((p) => p.speakerLabel === "Speaker 1")
        ?.name,
    ).toBe("Charlie");
    // Speaker 2 (un-renamed) got the auto name.
    expect(updated.segments.find((s) => s.segId === "s3")?.displayName).toBe("Bob");
    expect(
      store.getMeeting("m2")!.participants.find((p) => p.speakerLabel === "Speaker 2")
        ?.name,
    ).toBe("Bob");
  });
});

describe("applySpeakerNames — NO-OP cases keep generic labels", () => {
  it("apply:false resolutions => no file rewrite, no index, returns diarized unchanged", () => {
    const d = baseDiarized("m3");
    writeDiarizedTranscript(d);
    const before = readFileSync(meetingDiarizedTranscriptMdPath("m3"), "utf8");
    const store = makeStore({ diarized: d, meetings: [meeting("m3")] });
    const res = result("m3", [{ speaker: "Speaker 1", name: "Alice", apply: false }]);
    const updated = applySpeakerNames(store, res);
    expect(updated).toEqual(d);
    expect(store.indexed).toHaveLength(0);
    // The md was NOT rewritten with a name.
    expect(readFileSync(meetingDiarizedTranscriptMdPath("m3"), "utf8")).toBe(before);
    expect(before).toContain("Speaker 1: Hi there");
  });

  it("empty resolutions => no-op", () => {
    const d = baseDiarized("m4");
    writeDiarizedTranscript(d);
    const store = makeStore({ diarized: d, meetings: [meeting("m4")] });
    expect(applySpeakerNames(store, result("m4", []))).toEqual(d);
    expect(store.indexed).toHaveLength(0);
  });

  it("never-diarized meeting => null", () => {
    const store = makeStore({ diarized: null, meetings: [meeting("m5")] });
    expect(
      applySpeakerNames(store, result("m5", [{ speaker: "Speaker 1", name: "Alice" }])),
    ).toBeNull();
  });
});

describe("applySpeakerNames — live transcript stays byte-identical", () => {
  it("transcript.live.md + transcript.jsonl are unchanged after a merge", () => {
    const id = "m6";
    const d = baseDiarized(id);
    writeDiarizedTranscript(d);
    const { live, jsonl } = seedLiveFiles(id);
    const store = makeStore({
      diarized: d,
      meetings: [
        meeting(id, {
          participants: [
            { id: "Speaker 1", name: "Speaker 1", speakerLabel: "Speaker 1" },
          ],
        }),
      ],
    });

    applySpeakerNames(store, result(id, [{ speaker: "Speaker 1", name: "Alice" }]));

    // The applier touched the diarized files (md now has the name)...
    expect(readFileSync(meetingDiarizedTranscriptMdPath(id), "utf8")).toContain(
      "Alice: Hi there",
    );
    // ...but the LIVE transcript + structured jsonl are byte-for-byte unchanged.
    expect(readFileSync(meetingLiveTranscriptPath(id), "utf8")).toBe(live);
    expect(existsSync(meetingTranscriptPath(id, "structured"))).toBe(true);
    expect(readFileSync(meetingTranscriptPath(id, "structured"), "utf8")).toBe(jsonl);
  });

  it("a no-op merge does not even create a live transcript", () => {
    const id = "m7";
    const d = baseDiarized(id);
    writeDiarizedTranscript(d);
    const store = makeStore({ diarized: d, meetings: [meeting(id)] });
    applySpeakerNames(store, result(id, []));
    expect(existsSync(meetingLiveTranscriptPath(id))).toBe(false);
  });
});
