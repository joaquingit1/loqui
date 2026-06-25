/**
 * PRD-8 — semver comparator tests. Covers older/equal/newer + prerelease
 * precedence + the "fail closed" behavior for malformed versions (so a garbage
 * manifest can never trick the app into updating backwards).
 */
import { describe, expect, it } from "vitest";
import { compareVersions, isNewer, parseVersion } from "./semver.js";

describe("compareVersions / isNewer", () => {
  it("orders major/minor/patch numerically", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.3.0", "1.2.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats a prerelease as LOWER than the same release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
  });

  it("orders prerelease identifiers per semver 2.0.0 §11", () => {
    // numeric < numeric
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1);
    // numeric identifiers rank lower than alphanumeric
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // a longer prerelease (all preceding equal) is greater
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    // lexical for alphanumerics
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });

  it("ignores build metadata for precedence", () => {
    expect(compareVersions("1.2.3+build.5", "1.2.3+build.9")).toBe(0);
    expect(compareVersions("1.2.3+abc", "1.2.3")).toBe(0);
  });

  it("tolerates a leading v / whitespace", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("  1.2.4 ", "v1.2.3")).toBe(1);
  });

  it("fails closed: a malformed version parses to 0.0.0 and never out-ranks", () => {
    expect(parseVersion("not-a-version")).toEqual({ major: 0, minor: 0, patch: 0, pre: [] });
    // A garbage manifest version is NOT newer than any real running version.
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("", "0.0.1")).toBe(false);
    // ...but a real version IS newer than a garbage "current".
    expect(isNewer("1.0.0", "garbage")).toBe(true);
  });

  it("isNewer answers the one question the updater asks", () => {
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
    expect(isNewer("1.2.2", "1.2.3")).toBe(false);
  });
});
