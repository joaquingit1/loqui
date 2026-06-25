/**
 * PRD-8 — a tiny, dependency-free semver comparator for the updater.
 *
 * The updater only needs ONE operation: "is the manifest version strictly newer
 * than the running version?" — so we implement just enough of semver 2.0.0
 * (major.minor.patch with an optional `-prerelease` and an ignored `+build`) to
 * answer that deterministically, rather than pulling a runtime dependency. Pure +
 * total: a malformed version is treated as 0.0.0 so a garbage manifest can never
 * trick the app into "updating" backwards.
 *
 * Precedence rules implemented (per semver 2.0.0 §11):
 *   - numeric major/minor/patch compared numerically.
 *   - a version WITH a prerelease has LOWER precedence than the same version
 *     WITHOUT one (1.0.0-rc < 1.0.0).
 *   - prerelease identifiers compared left-to-right: numeric < numeric
 *     numerically; numeric identifiers always rank lower than alphanumeric; a
 *     longer prerelease (when all preceding match) is greater.
 *   - build metadata (`+...`) is ignored for precedence.
 */

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers (empty array = a normal release). */
  pre: string[];
}

const ZERO: ParsedVersion = { major: 0, minor: 0, patch: 0, pre: [] };

function toInt(s: string): number {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Parse a version string. Tolerates a leading `v`/`=` and whitespace. A
 * non-conforming string yields {@link ZERO} (so it can never out-rank a real
 * version) — the updater therefore "fails closed" toward not updating.
 */
export function parseVersion(input: string): ParsedVersion {
  if (typeof input !== "string") return { ...ZERO };
  const trimmed = input.trim().replace(/^[v=]/, "");
  // Split off build metadata (ignored) then the prerelease.
  const noBuild = trimmed.split("+", 1)[0] ?? "";
  const dash = noBuild.indexOf("-");
  const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preRaw = dash === -1 ? undefined : noBuild.slice(dash + 1);
  const parts = core.split(".");
  // A conforming core has a NUMERIC major; anything else is malformed -> 0.0.0
  // (so a garbage manifest version can never out-rank a real running version).
  if (parts.length < 1 || parts[0] === "" || !/^[0-9]+$/.test(parts[0] ?? "")) {
    return { ...ZERO };
  }
  const major = toInt(parts[0] ?? "0");
  const minor = toInt(parts[1] ?? "0");
  const patch = toInt(parts[2] ?? "0");
  const pre =
    preRaw && preRaw.length > 0 ? preRaw.split(".").filter((s) => s.length > 0) : [];
  return { major, minor, patch, pre };
}

const NUMERIC = /^[0-9]+$/;

/** Compare two prerelease identifier arrays per semver §11. */
function comparePre(a: string[], b: string[]): number {
  // No prerelease outranks having one.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a is a normal release => greater
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] as string;
    const bi = b[i] as string;
    const aNum = NUMERIC.test(ai);
    const bNum = NUMERIC.test(bi);
    if (aNum && bNum) {
      const d = toInt(ai) - toInt(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return aNum ? -1 : 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  // All shared identifiers equal: the longer set has higher precedence.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Compare two semver strings. Returns -1 if a < b, 0 if equal precedence, 1 if
 * a > b. Build metadata ignored; malformed inputs parse to 0.0.0.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  const pre = comparePre(pa.pre, pb.pre);
  return pre < 0 ? -1 : pre > 0 ? 1 : 0;
}

/**
 * Is `candidate` strictly newer than `current`? The ONE question the updater
 * asks the manifest. Equal or older => false (no update).
 */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
