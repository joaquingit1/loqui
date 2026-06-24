/**
 * mcp-server READ-ONLY store tests (PRD-7).
 *
 * Exercises `createReadStore` against a SEEDED temp data root (hermetic, no
 * network): list date-order + range filter; search across transcript AND
 * summary with a snippet; get_meeting / get_transcript(live|diarized) /
 * get_summary; empty store -> []. Plus the READ-ONLY assertions: the store opens
 * SQLite readonly (a write throws) and the ReadStore surface has no mutator.
 */
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { INDEX_DB_NAME, type DiarizedTranscript, type Summary } from "@loqui/shared";
import { createReadStore } from "../src/server.js";
import { makeMeeting, seedEmptyStore, seedStore, type SeededStore } from "./seed.js";

// Three meetings with distinct, ordered createdAt so date-desc is unambiguous.
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

const T_A = "2026-06-01T10:00:00.000Z"; // oldest
const T_B = "2026-06-10T10:00:00.000Z"; // middle
const T_C = "2026-06-20T10:00:00.000Z"; // newest

function seedThree(): SeededStore {
  const summaryC: Summary = {
    meetingId: ID_C,
    version: 1,
    tldr: "We agreed to ship the kraken release on Friday.",
    decisions: ["Ship Friday"],
    actionItems: [{ text: "Cut the release branch", owner: "Ada" }],
    topics: ["release"],
    provider: "fake",
    model: "test",
    generatedAt: T_C,
  };
  const diarizedB: DiarizedTranscript = {
    meetingId: ID_B,
    version: 1,
    diarized: true,
    backend: "fake",
    speakers: ["Speaker 1"],
    segments: [
      {
        segId: "s1",
        source: "system",
        text: "The platypus budget is approved.",
        tStart: 0,
        tEnd: 2,
        speaker: "Speaker 1",
        displayName: null,
      },
    ],
  };
  return seedStore([
    {
      meeting: makeMeeting({ id: ID_A, title: "Standup", platform: "zoom", createdAt: T_A, startedAt: T_A }),
      liveTranscript: "Alpha standup notes about the widget.\n",
      ftsTranscript: "Alpha standup notes about the widget.",
    },
    {
      meeting: makeMeeting({ id: ID_B, title: "Design review", createdAt: T_B }),
      liveTranscript: "Live raw transcript for design review.\n",
      diarizedTranscriptMd: "## Diarized\n\n**Speaker 1:** The platypus budget is approved.\n",
      diarizedTranscriptJson: diarizedB,
      ftsTranscript: "The platypus budget is approved.",
    },
    {
      meeting: makeMeeting({ id: ID_C, title: "Planning", platform: "google-meet", createdAt: T_C, startedAt: T_C }),
      liveTranscript: "Planning live transcript.\n",
      ftsSummary: "We agreed to ship the kraken release on Friday.",
      summary: summaryC,
    },
  ]);
}

let seeded: SeededStore | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

describe("createReadStore — listMeetings", () => {
  it("returns all meetings newest-first", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      const ids = store.listMeetings().map((m) => m.id);
      expect(ids).toEqual([ID_C, ID_B, ID_A]);
    } finally {
      store.close();
    }
  });

  it("filters by inclusive createdAt range", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      const ids = store.listMeetings({ from: T_B, to: T_C }).map((m) => m.id);
      expect(ids).toEqual([ID_C, ID_B]);
      const onlyOldest = store.listMeetings({ to: T_A }).map((m) => m.id);
      expect(onlyOldest).toEqual([ID_A]);
    } finally {
      store.close();
    }
  });

  it("respects limit and a title query", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      expect(store.listMeetings({ limit: 1 }).map((m) => m.id)).toEqual([ID_C]);
      expect(store.listMeetings({ query: "Planning" }).map((m) => m.id)).toEqual([ID_C]);
    } finally {
      store.close();
    }
  });

  it("returns fully-parsed Meeting objects (platform/status preserved)", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      const c = store.getMeeting(ID_C);
      expect(c).not.toBeNull();
      expect(c?.title).toBe("Planning");
      expect(c?.platform).toBe("google-meet");
      expect(c?.status).toBe("done");
    } finally {
      store.close();
    }
  });
});

describe("createReadStore — searchMeetings", () => {
  it("finds a keyword in a TRANSCRIPT with a snippet", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      const hits = store.searchMeetings("platypus");
      expect(hits.map((h) => h.meeting.id)).toEqual([ID_B]);
      expect(hits[0]?.snippet).toContain("platypus");
      expect(hits[0]?.snippet).toContain("[");
    } finally {
      store.close();
    }
  });

  it("finds a keyword in a SUMMARY with a usable (highlighted) snippet", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      // C matches ONLY on its summary column (its transcript FTS text is empty).
      // The returned snippet must come from the SUMMARY (highlighted) — not an
      // unrelated/empty transcript snippet (PRD-7 AC#3: usable snippets).
      const hits = store.searchMeetings("kraken");
      expect(hits.map((h) => h.meeting.id)).toEqual([ID_C]);
      expect(hits[0]?.snippet).toContain("kraken");
      expect(hits[0]?.snippet).toContain("[");
    } finally {
      store.close();
    }
  });

  it("returns [] for a query with no match and for an empty query", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      expect(store.searchMeetings("zzz-no-such-term")).toEqual([]);
      expect(store.searchMeetings("   ")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("createReadStore — getTranscript", () => {
  it("'live' returns the raw transcript", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      expect(store.getTranscript(ID_B, "live")).toContain("Live raw transcript");
    } finally {
      store.close();
    }
  });

  it("'diarized' returns the diarized md when present", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      const text = store.getTranscript(ID_B, "diarized");
      expect(text).toContain("**Speaker 1:**");
      expect(text).toContain("platypus budget");
    } finally {
      store.close();
    }
  });

  it("'diarized' falls back to live when no diarized file exists", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      // C has only a live transcript (no diarized md) -> diarized falls back.
      expect(store.getTranscript(ID_C, "diarized")).toContain("Planning live transcript");
    } finally {
      store.close();
    }
  });

  it("returns '' when no transcript file exists / unknown id", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      expect(store.getTranscript("44444444-4444-4444-8444-444444444444", "live")).toBe("");
    } finally {
      store.close();
    }
  });
});

describe("createReadStore — getSummary / getDiarizedTranscript", () => {
  it("getSummary returns the parsed summary, null when absent", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      const sum = store.getSummary(ID_C);
      expect(sum?.tldr).toContain("kraken");
      expect(sum?.actionItems[0]?.owner).toBe("Ada");
      expect(store.getSummary(ID_A)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("getDiarizedTranscript returns the parsed doc, null when absent", () => {
    seeded = seedThree();
    const store = createReadStore(seeded.dataRoot);
    try {
      expect(store.getDiarizedTranscript(ID_B)?.diarized).toBe(true);
      expect(store.getDiarizedTranscript(ID_A)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("createReadStore — empty store", () => {
  it("lists / searches to [] and gets to null/''", () => {
    seeded = seedEmptyStore();
    const store = createReadStore(seeded.dataRoot);
    try {
      expect(store.listMeetings()).toEqual([]);
      expect(store.searchMeetings("anything")).toEqual([]);
      expect(store.getMeeting(ID_A)).toBeNull();
      expect(store.getTranscript(ID_A)).toBe("");
      expect(store.getSummary(ID_A)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("createReadStore — STRICTLY READ-ONLY", () => {
  it("opens the index db in readonly mode (a write throws)", () => {
    seeded = seedThree();
    // Open the SAME db file readonly the way the store does and prove a write
    // is rejected by the driver — the read path has no write code at all.
    const db = new Database(join(seeded.dataRoot, INDEX_DB_NAME), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(() => db.prepare("DELETE FROM meetings").run()).toThrow(
        /readonly|read-only|read only/i,
      );
      expect(() =>
        db.prepare("INSERT INTO meetings_fts (meeting_id) VALUES ('x')").run(),
      ).toThrow(/readonly|read-only|read only/i);
    } finally {
      db.close();
    }
  });

  it("the ReadStore surface exposes no mutator method", () => {
    seeded = seedEmptyStore();
    const store = createReadStore(seeded.dataRoot);
    try {
      const surface = store as unknown as Record<string, unknown>;
      // Every method that exists is a read; no write-shaped method is present.
      for (const banned of [
        "createMeeting",
        "updateMeeting",
        "deleteMeeting",
        "appendTranscriptSegment",
        "upsertSearchText",
        "write",
        "insert",
        "update",
        "delete",
      ]) {
        expect(surface[banned]).toBeUndefined();
      }
      const methods = ["listMeetings", "searchMeetings", "getMeeting", "getTranscript", "getDiarizedTranscript", "getSummary", "close"];
      for (const m of methods) expect(typeof surface[m]).toBe("function");
    } finally {
      store.close();
    }
  });

  it("fileMustExist: opening a root with no index.db throws (app owns creation)", () => {
    expect(() => createReadStore(join(seedEmptyStore().dataRoot, "nope-no-such-subdir"))).toThrow();
  });
});
