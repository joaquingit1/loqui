/**
 * Hermetic tests for the meeting store.
 *
 * Every test points LOQUI_DATA_DIR at a fresh os.tmpdir() subdirectory in a
 * beforeEach and removes it in afterEach, so the real ~/Loqui is NEVER touched.
 * paths.ts reads the env var at call time, so per-test override works.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_ENV, meetingSchema } from "@loqui/shared";
import {
  openStore,
  type MeetingStore,
  dataRoot,
  meetingsDir,
  meetingDir,
  meetingMetaPath,
  indexDbPath,
} from "./index.js";
import { META_TMP_SUFFIX } from "./meta.js";

let tmp: string;
let store: MeetingStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loqui-store-"));
  process.env[DATA_DIR_ENV] = tmp;
  store = openStore();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed in some tests */
  }
  delete process.env[DATA_DIR_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

describe("data-root resolution", () => {
  it("resolves the data root from LOQUI_DATA_DIR", () => {
    expect(dataRoot()).toBe(tmp);
    expect(meetingsDir()).toBe(join(tmp, "meetings"));
    expect(indexDbPath()).toBe(join(tmp, "index.db"));
  });

  it("creates the data root + meetings dir + index.db on open", () => {
    expect(existsSync(meetingsDir())).toBe(true);
    expect(existsSync(indexDbPath())).toBe(true);
  });
});

describe("create -> get -> list round-trip", () => {
  it("creates a meeting, reads it back, and lists it", () => {
    const created = store.createMeeting({ title: "Standup", platform: "zoom" });

    // Returned object is a fully-validated Meeting.
    expect(() => meetingSchema.parse(created)).not.toThrow();
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.title).toBe("Standup");
    expect(created.platform).toBe("zoom");
    expect(created.status).toBe("recording");
    expect(created.createdAt).toBe(created.updatedAt);

    // meta.json written to disk.
    const metaPath = meetingMetaPath(created.id);
    expect(existsSync(metaPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(onDisk.id).toBe(created.id);

    // get round-trips.
    const got = store.getMeeting(created.id);
    expect(got).toEqual(created);

    // list returns it.
    const list = store.listMeetings();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(created);
  });

  // PRD-12: the `kind` discriminator round-trips through meta.json + the store,
  // and an OLD meta.json (written before `kind` existed) loads as "meeting".
  it("persists + round-trips the meeting kind, defaulting old records to 'meeting'", () => {
    const normal = store.createMeeting({ title: "Standup" });
    const imported = store.createMeeting({ title: "clip.m4a", kind: "import" });
    const memo = store.createMeeting({ title: "Note", kind: "voice-memo" });

    expect(normal.kind).toBe("meeting");
    expect(store.getMeeting(imported.id)?.kind).toBe("import");
    expect(store.getMeeting(memo.id)?.kind).toBe("voice-memo");

    // meta.json carries the kind for the non-default kinds.
    const onDisk = JSON.parse(readFileSync(meetingMetaPath(imported.id), "utf8"));
    expect(onDisk.kind).toBe("import");

    // Simulate a pre-PRD-12 meta.json with NO `kind` field: it must still load
    // (defaulted to "meeting") rather than failing to parse.
    const legacy = { ...onDisk };
    delete legacy.kind;
    writeFileSync(meetingMetaPath(imported.id), JSON.stringify(legacy), "utf8");
    expect(store.getMeeting(imported.id)?.kind).toBe("meeting");

    // All kinds list + are treated uniformly (newest-first, all present).
    expect(store.listMeetings().map((m) => m.id).sort()).toEqual(
      [normal.id, imported.id, memo.id].sort(),
    );
  });

  it("createMeeting() with no input defaults everything", () => {
    const m = store.createMeeting();
    expect(m.title).toBe("");
    expect(m.platform).toBeNull();
    expect(m.participants).toEqual([]);
    expect(m.modelVersions).toEqual({});
    expect(m.startedAt).toBeNull();
    expect(m.status).toBe("recording");
  });

  it("getMeeting returns null for an unknown id", () => {
    expect(store.getMeeting("11111111-1111-1111-1111-111111111111")).toBeNull();
  });

  it("persists across reopen (survives an app restart)", () => {
    const created = store.createMeeting({ title: "Persisted" });
    store.close();

    const reopened = openStore();
    try {
      const got = reopened.getMeeting(created.id);
      expect(got).toEqual(created);
      expect(reopened.listMeetings()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe("updateMeeting", () => {
  it("patches mutable fields, bumps updatedAt, keeps id/createdAt", async () => {
    const created = store.createMeeting({ title: "Before" });
    // Ensure a measurable clock tick so updatedAt strictly advances.
    await new Promise((r) => setTimeout(r, 5));

    const updated = store.updateMeeting(created.id, {
      title: "After",
      status: "done",
      participants: [{ id: "p1", name: "Ada", speakerLabel: "spk_0" }],
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.title).toBe("After");
    expect(updated.status).toBe("done");
    expect(updated.participants).toHaveLength(1);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    // Persisted + indexed.
    expect(store.getMeeting(created.id)).toEqual(updated);
    expect(readFileSync(meetingMetaPath(created.id), "utf8")).toContain(
      "After",
    );
  });

  it("throws when updating an unknown meeting", () => {
    expect(() =>
      store.updateMeeting("22222222-2222-2222-2222-222222222222", {
        title: "x",
      }),
    ).toThrow(/unknown meeting/);
  });

  it("ignores attempts to override id/createdAt/updatedAt via patch", () => {
    const created = store.createMeeting({ title: "x" });
    const sneaky = {
      id: "99999999-9999-9999-9999-999999999999",
      createdAt: "1999-01-01T00:00:00.000Z",
      title: "y",
    } as never;
    const updated = store.updateMeeting(created.id, sneaky);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.title).toBe("y");
  });
});

describe("listMeetings ordering + filtering", () => {
  it("returns [] for an empty store", () => {
    expect(store.listMeetings()).toEqual([]);
  });

  it("orders newest-first by createdAt", () => {
    // Backdate via the index by creating then rewriting createdAt through the
    // public path: create three with distinct createdAt by manual meta + index.
    const a = store.createMeeting({ title: "a" });
    const b = store.createMeeting({ title: "b" });
    const c = store.createMeeting({ title: "c" });

    // All three created within the same ms in CI is possible; force a strict
    // ordering by rewriting createdAt directly on disk + reindexing via reopen.
    backdate(a.id, "2026-01-01T00:00:00.000Z");
    backdate(b.id, "2026-02-01T00:00:00.000Z");
    backdate(c.id, "2026-03-01T00:00:00.000Z");
    store.close();

    const reopened = reindexAll();
    try {
      const titles = reopened.listMeetings().map((m) => m.title);
      expect(titles).toEqual(["c", "b", "a"]);
    } finally {
      reopened.close();
    }
  });

  it("filters by since/until date range (inclusive)", () => {
    const a = store.createMeeting({ title: "jan" });
    const b = store.createMeeting({ title: "feb" });
    const c = store.createMeeting({ title: "mar" });
    backdate(a.id, "2026-01-15T00:00:00.000Z");
    backdate(b.id, "2026-02-15T00:00:00.000Z");
    backdate(c.id, "2026-03-15T00:00:00.000Z");
    store.close();

    const reopened = reindexAll();
    try {
      const inRange = reopened.listMeetings({
        since: "2026-02-01T00:00:00.000Z",
        until: "2026-02-28T00:00:00.000Z",
      });
      expect(inRange.map((m) => m.title)).toEqual(["feb"]);

      const fromFeb = reopened.listMeetings({
        since: "2026-02-01T00:00:00.000Z",
      });
      expect(fromFeb.map((m) => m.title)).toEqual(["mar", "feb"]);
    } finally {
      reopened.close();
    }
  });

  it("respects the limit option", () => {
    store.createMeeting({ title: "1" });
    store.createMeeting({ title: "2" });
    store.createMeeting({ title: "3" });
    expect(store.listMeetings({ limit: 2 })).toHaveLength(2);
  });
});

describe("FTS title search", () => {
  it("finds meetings by title query and excludes non-matches", () => {
    const planning = store.createMeeting({ title: "Q3 Planning Session" });
    store.createMeeting({ title: "Daily Standup" });

    const hits = store.listMeetings({ query: "Planning" });
    expect(hits.map((m) => m.id)).toEqual([planning.id]);

    expect(store.listMeetings({ query: "nonexistent" })).toEqual([]);
  });

  it("reflects title changes from updateMeeting in the FTS index", () => {
    const m = store.createMeeting({ title: "Original Topic" });
    expect(store.listMeetings({ query: "Original" }).map((x) => x.id)).toEqual([
      m.id,
    ]);

    store.updateMeeting(m.id, { title: "Renamed Topic" });
    expect(store.listMeetings({ query: "Original" })).toEqual([]);
    expect(store.listMeetings({ query: "Renamed" }).map((x) => x.id)).toEqual([
      m.id,
    ]);
  });

  it("treats a query with FTS operators/punctuation as a literal phrase", () => {
    const m = store.createMeeting({ title: 'Release "v2" - kickoff' });
    // These would be FTS5 syntax errors if not escaped into a phrase.
    expect(() => store.listMeetings({ query: 'v2" -' })).not.toThrow();
    expect(
      store.listMeetings({ query: "kickoff" }).map((x) => x.id),
    ).toEqual([m.id]);
  });

  it("upsertSearchText indexes transcript/summary text (later-PRD stub path)", () => {
    const m = store.createMeeting({ title: "Sync" });
    store.upsertSearchText({
      meetingId: m.id,
      transcript: "we discussed the quarterly roadmap and budget",
    });
    expect(
      store.listMeetings({ query: "roadmap" }).map((x) => x.id),
    ).toEqual([m.id]);
    // Title still searchable; transcript update must not clobber it.
    expect(store.listMeetings({ query: "Sync" }).map((x) => x.id)).toEqual([
      m.id,
    ]);
  });
});

describe("atomic writes", () => {
  it("a leftover temp file from a simulated crash is ignored", () => {
    const created = store.createMeeting({ title: "Real" });

    // Simulate a crash mid-write: a partially-written temp file is left in the
    // meeting dir. It must NOT be read as a meeting, and list/get must still
    // return the committed meta.json.
    const orphan = `${meetingMetaPath(created.id)}${META_TMP_SUFFIX}garbage`;
    writeFileSync(orphan, "{ this is not valid json");

    expect(store.getMeeting(created.id)?.title).toBe("Real");
    expect(store.listMeetings()).toHaveLength(1);
    expect(existsSync(orphan)).toBe(true); // we don't require cleanup, only that it's ignored
  });

  it("never leaves a partial meta.json visible at the target path", () => {
    const created = store.createMeeting({ title: "Atomic" });
    // The committed file parses cleanly (no partial content).
    const onDisk = JSON.parse(readFileSync(meetingMetaPath(created.id), "utf8"));
    expect(meetingSchema.parse(onDisk).title).toBe("Atomic");
  });

  it("a stray dir under meetings/ without meta.json does not crash listing", () => {
    store.createMeeting({ title: "ok" });
    // A half-created meeting dir (crash before meta.json existed) — but it's
    // not in the index, so listing simply doesn't include it.
    const strayId = "33333333-3333-3333-3333-333333333333";
    mkdtempSync(join(meetingsDir(), `${strayId}-`));
    expect(() => store.listMeetings()).not.toThrow();
    expect(store.listMeetings()).toHaveLength(1);
  });
});

describe("adversarial inputs", () => {
  it("rejects path-traversal ids in getMeeting/updateMeeting", () => {
    for (const bad of [
      "../escape",
      "..",
      ".",
      "a/b",
      "a\\b",
      "with space",
      "with nul",
      "",
      "x".repeat(200),
    ]) {
      expect(() => store.getMeeting(bad)).toThrow(/invalid meeting id/);
      expect(() => store.updateMeeting(bad, { title: "x" })).toThrow(
        /invalid meeting id/,
      );
    }
  });

  it("a path-traversal id cannot escape the meetings dir on write", () => {
    // upsertSearchText guards the id; confirm a traversal id is rejected before
    // it can touch the filesystem/index.
    expect(() =>
      store.upsertSearchText({ meetingId: "../../evil", title: "x" }),
    ).toThrow(/invalid meeting id/);
  });

  it("createMeeting always mints a fresh valid uuid (caller cannot inject id)", () => {
    // The input schema omits id; even if a caller forces one in, it's stripped.
    const m = store.createMeeting({ id: "../evil" } as never);
    expect(m.id).not.toBe("../evil");
    expect(m.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // And it lives strictly under meetings/<uuid>/.
    expect(existsSync(meetingDir(m.id))).toBe(true);
  });

  it("handles a very long title", () => {
    const longTitle = "L".repeat(20000);
    const m = store.createMeeting({ title: longTitle });
    expect(store.getMeeting(m.id)?.title).toBe(longTitle);
    // And it's still findable by a token within it.
    expect(store.listMeetings({ query: longTitle.slice(0, 50) })).toHaveLength(
      0,
    ); // partial-of-one-giant-token won't match, but must not throw
  });

  it("handles unicode + emoji titles end-to-end (store + FTS)", () => {
    const title = "Café ☕ réunion 会議 🎙️ planning";
    const m = store.createMeeting({ title });
    expect(store.getMeeting(m.id)?.title).toBe(title);
    // Diacritic-folded search (tokenizer removes diacritics) finds it.
    expect(
      store.listMeetings({ query: "cafe" }).map((x) => x.id),
    ).toEqual([m.id]);
    // CJK token search finds it too.
    expect(
      store.listMeetings({ query: "会議" }).map((x) => x.id),
    ).toEqual([m.id]);
  });

  it("concurrent createMeeting yields distinct ids and files", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        Promise.resolve().then(() =>
          store.createMeeting({ title: `concurrent-${i}` }),
        ),
      ),
    );
    const ids = new Set(results.map((m) => m.id));
    expect(ids.size).toBe(25);
    expect(store.listMeetings()).toHaveLength(25);
    // Every meta.json exists and parses.
    for (const m of results) {
      expect(meetingSchema.parse(store.getMeeting(m.id))).toBeTruthy();
    }
  });
});

// --- helpers ---------------------------------------------------------------

/** Rewrite a meeting's createdAt directly on its meta.json (test-only). */
function backdate(id: string, createdAt: string): void {
  const p = meetingMetaPath(id);
  const obj = JSON.parse(readFileSync(p, "utf8"));
  obj.createdAt = createdAt;
  // Atomic-ish for the test: openSync/writeSync/closeSync is fine here.
  const fd = openSync(p, "w");
  writeSync(fd, `${JSON.stringify(obj, null, 2)}\n`);
  closeSync(fd);
}

/**
 * Reopen the store and re-sync each index row from its (possibly back-dated)
 * meta.json. updateMeeting preserves createdAt and re-upserts the row, so the
 * index's created_at picks up the back-dated value used for ordering tests.
 */
function reindexAll(): MeetingStore {
  const s = openStore();
  for (const id of readdirSync(meetingsDir())) {
    if (s.getMeeting(id)) s.updateMeeting(id, {});
  }
  return s;
}

describe("PRD-3 transcript indexing + library queries", () => {
  it("appendTranscriptSegment indexes transcript text and makes it FTS-searchable", () => {
    const m = store.createMeeting({ title: "Standup" });
    store.appendTranscriptSegment(m.id, "s1", "discuss the quarterly roadmap");
    store.appendTranscriptSegment(m.id, "s2", "and the budget review");

    const hits = store.searchMeetings("roadmap");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.meeting.id).toBe(m.id);
    expect(hits[0]!.snippet.toLowerCase()).toContain("roadmap");
  });

  it("appendTranscriptSegment is idempotent per (meeting, segId)", () => {
    const m = store.createMeeting({ title: "Repeat" });
    store.appendTranscriptSegment(m.id, "dup", "unicornword appears once");
    store.appendTranscriptSegment(m.id, "dup", "unicornword appears once");
    // The word still matches, but only one copy is indexed (snippet has it once).
    const hits = store.searchMeetings("unicornword");
    expect(hits).toHaveLength(1);
    const occurrences = (hits[0]!.snippet.match(/unicornword/gi) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("searchMeetings returns [] for an empty query and no FTS syntax errors on operators", () => {
    const m = store.createMeeting({ title: "Ops" });
    store.appendTranscriptSegment(m.id, "s1", "release the q-3 build now");
    expect(store.searchMeetings("")).toEqual([]);
    // Hyphen/quote would be FTS operators if unescaped; phrase-quoting handles it.
    expect(() => store.searchMeetings('q-3 "build"')).not.toThrow();
  });

  it("getTranscript returns '' when no transcript file exists yet", () => {
    const m = store.createMeeting();
    expect(store.getTranscript(m.id)).toBe("");
    expect(store.getTranscript(m.id, "structured")).toBe("");
  });

  it("getTranscript reads back the live transcript file when present", () => {
    const m = store.createMeeting();
    const p = join(meetingDir(m.id), "transcript.live.md");
    writeFileSync(p, "[00:00:01] You said: hello\n");
    expect(store.getTranscript(m.id)).toBe("[00:00:01] You said: hello\n");
    expect(store.getTranscript(m.id, "live")).toContain("You said: hello");
  });

  it("listMeetings honors from/to date-range bounds", () => {
    const a = store.createMeeting({ title: "Old" });
    const b = store.createMeeting({ title: "New" });
    backdate(a.id, "2020-01-01T00:00:00.000Z");
    backdate(b.id, "2025-01-01T00:00:00.000Z");
    const s = reindexAll();
    try {
      const inRange = s.listMeetings({ from: "2024-01-01T00:00:00.000Z" });
      expect(inRange.map((m) => m.id)).toEqual([b.id]);
      const bounded = s.listMeetings({
        from: "2019-01-01T00:00:00.000Z",
        to: "2021-01-01T00:00:00.000Z",
      });
      expect(bounded.map((m) => m.id)).toEqual([a.id]);
    } finally {
      s.close();
    }
  });
});

describe("getTranscript — high-accuracy (hifi) precedence (PRD-2 two-tier)", () => {
  it("returns the live transcript when no hi-fi pass exists", () => {
    const m = store.createMeeting({ title: "M" });
    writeFileSync(join(meetingDir(m.id), "transcript.live.md"), "[00:00:00] You said: live\n");
    expect(store.getTranscript(m.id, "live")).toBe("[00:00:00] You said: live\n");
  });

  it("PREFERS transcript.hifi.md over transcript.live.md once re-transcription wrote it", () => {
    const m = store.createMeeting({ title: "M" });
    const dir = meetingDir(m.id);
    writeFileSync(join(dir, "transcript.live.md"), "[00:00:00] You said: live\n");
    writeFileSync(join(dir, "transcript.hifi.md"), "[00:00:00] You said: accurate\n");
    // The live file stays byte-identical (the AI-never-edits invariant) — the
    // store just prefers the better re-transcription at read time.
    expect(readFileSync(join(dir, "transcript.live.md"), "utf8")).toBe(
      "[00:00:00] You said: live\n",
    );
    expect(store.getTranscript(m.id, "live")).toBe("[00:00:00] You said: accurate\n");
  });

  it("PREFERS transcript.hifi.jsonl for the structured variant", () => {
    const m = store.createMeeting({ title: "M" });
    const dir = meetingDir(m.id);
    writeFileSync(join(dir, "transcript.jsonl"), '{"segId":"s0","text":"live"}\n');
    writeFileSync(join(dir, "transcript.hifi.jsonl"), '{"segId":"hifi-0","text":"accurate"}\n');
    expect(store.getTranscript(m.id, "structured")).toBe('{"segId":"hifi-0","text":"accurate"}\n');
  });

  it("returns '' when neither the hi-fi nor the live transcript exists", () => {
    const m = store.createMeeting({ title: "M" });
    expect(store.getTranscript(m.id, "live")).toBe("");
  });
});
