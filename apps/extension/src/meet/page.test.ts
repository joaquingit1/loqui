/**
 * PRD-6 — page-helper tests (pure URL parsing + total DOM helpers).
 */
import { describe, expect, it } from "vitest";
import { isInCall, parseMeetingCode, resolveParticipantRoot } from "./page.js";
import { parseFixtureHtml } from "./fixtures/dom.js";

describe("parseMeetingCode", () => {
  it("extracts a code from a meeting URL", () => {
    expect(parseMeetingCode("https://meet.google.com/abc-defg-hij")).toBe(
      "abc-defg-hij",
    );
    expect(parseMeetingCode("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(
      "abc-defg-hij",
    );
  });

  it("returns null for non-meeting paths and other hosts", () => {
    expect(parseMeetingCode("https://meet.google.com/")).toBeNull();
    expect(parseMeetingCode("https://meet.google.com/new")).toBeNull();
    expect(parseMeetingCode("https://meet.google.com/landing")).toBeNull();
    expect(parseMeetingCode("https://example.com/abc-defg-hij")).toBeNull();
  });

  it("returns null for nullish / garbage input (never throws)", () => {
    expect(parseMeetingCode(null)).toBeNull();
    expect(parseMeetingCode(undefined)).toBeNull();
    expect(parseMeetingCode("not a url")).toBeNull();
  });
});

describe("isInCall / resolveParticipantRoot (total)", () => {
  it("isInCall true when a participant tile is present", () => {
    const doc = parseFixtureHtml(
      '<div data-participant-id="p1"></div>',
    ) as unknown as Document;
    expect(isInCall(doc)).toBe(true);
  });

  it("isInCall false on the lobby (no tiles) and for null", () => {
    const lobby = parseFixtureHtml("<div>lobby</div>") as unknown as Document;
    expect(isInCall(lobby)).toBe(false);
    expect(isInCall(null)).toBe(false);
  });

  it("resolveParticipantRoot prefers the panel, falls back to doc, null-safe", () => {
    const withPanel = parseFixtureHtml(
      '<div role="list" aria-label="Participants"><div data-participant-id="x"></div></div>',
    ) as unknown as Document;
    expect(resolveParticipantRoot(withPanel)).not.toBeNull();
    const noPanel = parseFixtureHtml(
      '<div data-participant-id="x"></div>',
    ) as unknown as Document;
    // Falls back to the document itself.
    expect(resolveParticipantRoot(noPanel)).toBe(noPanel);
    expect(resolveParticipantRoot(null)).toBeNull();
  });
});
