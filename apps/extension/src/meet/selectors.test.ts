/**
 * PRD-6 — hermetic selector tests.
 *
 * Runs the PRODUCTION createDomMeetSelectors against captured Meet HTML fixtures
 * parsed into a tiny in-process DOM (no jsdom, no live Meet). Asserts:
 *  - the participant list + active-speaker indicator parse from the primary
 *    fixture AND a DOM variant (multi-candidate selectors are resilient);
 *  - name decorations are cleaned;
 *  - a SELECTOR MISS / malformed root DEGRADES to []/null and NEVER throws.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cleanDisplayName,
  createDomMeetSelectors,
  MEET_SELECTOR_VERSION,
} from "./selectors.js";
import { parseFixtureHtml } from "./fixtures/dom.js";

const here = dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): ParentNode {
  return parseFixtureHtml(readFileSync(join(here, "fixtures", name), "utf8"));
}

describe("createDomMeetSelectors — primary panel fixture", () => {
  const selectors = createDomMeetSelectors();
  const root = loadFixture("meet-2026-06-24.html");

  it("reports the date-stamped selector version", () => {
    expect(selectors.version).toBe(MEET_SELECTOR_VERSION);
  });

  it("lists participant names (cleaned of (You))", () => {
    expect(selectors.listParticipants(root)).toEqual([
      "Alex Rivera",
      "Jordan Kim",
      "Sam Lee",
    ]);
  });

  it("reads the active speaker from the highlighted row", () => {
    const readings = selectors.readActiveSpeakers(root);
    const map = new Map(readings.map((r) => [r.name, r.speaking]));
    expect(map.get("Alex Rivera")).toBe(true);
    expect(map.get("Jordan Kim")).toBe(false);
    expect(map.get("Sam Lee")).toBe(false);
  });
});

describe("createDomMeetSelectors — grid variant fixture (rollout resilience)", () => {
  const selectors = createDomMeetSelectors();
  const root = loadFixture("meet-grid-2026-06-24.html");

  it("reads names via the [data-tooltip] fallback when .zWGUib is absent", () => {
    expect(selectors.listParticipants(root)).toEqual(["Alex Rivera", "Jordan Kim"]);
  });

  it("detects the active speaker via the jsname/class fallback marker", () => {
    const map = new Map(
      selectors.readActiveSpeakers(root).map((r) => [r.name, r.speaking]),
    );
    expect(map.get("Jordan Kim")).toBe(true);
    expect(map.get("Alex Rivera")).toBe(false);
  });
});

describe("graceful degradation (#1 invariant)", () => {
  const selectors = createDomMeetSelectors();

  it("returns [] for an empty document — never throws", () => {
    const empty = parseFixtureHtml("<div></div>");
    expect(selectors.listParticipants(empty)).toEqual([]);
    expect(selectors.readActiveSpeakers(empty)).toEqual([]);
  });

  it("returns [] when the participant markup is absent (selector miss)", () => {
    const noPanel = parseFixtureHtml(
      "<main><section>no participant rows here</section></main>",
    );
    expect(selectors.listParticipants(noPanel)).toEqual([]);
    expect(selectors.readActiveSpeakers(noPanel)).toEqual([]);
  });

  it("does not throw on a null/garbage root", () => {
    // @ts-expect-error — intentionally passing a bad root to prove totality.
    expect(() => selectors.listParticipants(null)).not.toThrow();
    // @ts-expect-error — intentionally passing a bad root to prove totality.
    expect(selectors.listParticipants(null)).toEqual([]);
    const throwingRoot = {
      querySelectorAll() {
        throw new Error("boom");
      },
    } as unknown as ParentNode;
    expect(() => selectors.readActiveSpeakers(throwingRoot)).not.toThrow();
    expect(selectors.readActiveSpeakers(throwingRoot)).toEqual([]);
  });
});

describe("cleanDisplayName", () => {
  it("strips a trailing (You)/(Presentation)/(Host) suffix + collapses ws", () => {
    expect(cleanDisplayName("  Sam   Lee  (You) ")).toBe("Sam Lee");
    expect(cleanDisplayName("Alex Rivera (Presentation)")).toBe("Alex Rivera");
    expect(cleanDisplayName("Jordan Kim (Host)")).toBe("Jordan Kim");
  });

  it("returns '' for empty/nullish input", () => {
    expect(cleanDisplayName("")).toBe("");
    expect(cleanDisplayName(null)).toBe("");
    expect(cleanDisplayName(undefined)).toBe("");
  });

  it("keeps a parenthetical that isn't a known suffix", () => {
    expect(cleanDisplayName("Dr. (Pat) Quinn")).toBe("Dr. (Pat) Quinn");
  });
});
