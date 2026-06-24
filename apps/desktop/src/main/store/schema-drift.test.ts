/**
 * PRD-7 writer↔reader schema-drift guard.
 *
 * The shared read-only store-reader (@loqui/shared store-read.ts) promises the
 * MCP server "can never drift from the writer's schema". That promise is only
 * real if SOMETHING asserts the live writer index.db matches the shared
 * constants the MCP reader queries against. This test is that assertion on the
 * WRITER side: it opens a fresh index.db via the writer's own openIndexDb and
 * checks that the table/column names and — critically — the FTS5 column
 * ordinals the shared snippet() expressions hardcode still line up. If a future
 * writer migration reorders/renames the FTS columns, this fails loudly here
 * rather than silently returning wrong snippets through the MCP server.
 */
import { describe, expect, it } from "vitest";
import { STORE_INDEX, STORE_READ_SQL } from "@loqui/shared";
import { openIndexDb } from "./db.js";

describe("index.db schema matches the shared store-read contract", () => {
  it("the meetings + FTS tables exist under the shared names", () => {
    const db = openIndexDb(":memory:");
    try {
      const names = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names).toContain(STORE_INDEX.meetingsTable);
      expect(names).toContain(STORE_INDEX.ftsTable);
    } finally {
      db.close();
    }
  });

  it("the FTS5 columns are in the ordinal positions the shared snippet() SQL uses", () => {
    const db = openIndexDb(":memory:");
    try {
      // PRAGMA table_info on an FTS5 table reports its columns (cid = ordinal).
      const cols = (
        db.prepare(`PRAGMA table_info(${STORE_INDEX.ftsTable})`).all() as Array<{
          cid: number;
          name: string;
        }>
      ).sort((a, b) => a.cid - b.cid);
      const byName = new Map(cols.map((c) => [c.name, c.cid]));

      // The 4 indexed columns in the order the writer declares them.
      expect(cols.map((c) => c.name)).toEqual([
        "meeting_id",
        "title",
        "transcript",
        "summary",
      ]);

      // The exact ordinals the shared reader's snippet() expressions hardcode.
      expect(byName.get("transcript")).toBe(STORE_INDEX.ftsTranscriptColumnIndex);
      expect(byName.get("summary")).toBe(STORE_INDEX.ftsSummaryColumnIndex);
    } finally {
      db.close();
    }
  });

  it("the shared snippet() expressions target those same column ordinals", () => {
    // Belt-and-suspenders: the SQL strings the reader runs must reference the
    // ordinals asserted above, so the two halves of the contract stay coupled.
    expect(STORE_READ_SQL.snippetExpr).toContain(
      `, ${STORE_INDEX.ftsTranscriptColumnIndex},`,
    );
    expect(STORE_READ_SQL.summarySnippetExpr).toContain(
      `, ${STORE_INDEX.ftsSummaryColumnIndex},`,
    );
  });
});
