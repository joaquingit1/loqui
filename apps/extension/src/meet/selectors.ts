/**
 * PRD-6 — the SWAPPABLE Google Meet DOM-selector module.
 *
 * This is the SINGLE place Meet's volatile DOM is touched. Everything that reads
 * Meet's markup (the participant list + the active-speaker indicator) goes
 * through {@link MeetSelectors}; the rest of the content script depends ONLY on
 * this interface, never on raw selectors. When Meet changes its DOM (which it
 * does without notice), the fix is isolated to ONE implementation here + ONE
 * fixture — nothing else moves.
 *
 * #1 INVARIANT — A SELECTOR MISS DEGRADES, IT NEVER THROWS. Every method MUST be
 * total: on a missing/changed node it returns an empty list / null and (at most)
 * logs — it never throws into the Meet page and never emits bad data. The
 * content script treats `[]` / `null` as "couldn't read it this tick" and simply
 * sends nothing; Loqui then completes the meeting with generic `Speaker N`
 * labels. Tests run this implementation against captured Meet HTML (see
 * ./fixtures/) parsed into a minimal read-only {@link ParentNode} — never a live
 * Meet page and never a DOM library.
 *
 * SELECTOR UPDATE PROCESS (documented, so a future maintainer can do it safely):
 *   1. Capture the current Meet DOM into a new fixture under
 *      apps/extension/src/meet/fixtures/meet-<yyyy-mm-dd>.html (participant
 *      panel + an active speaker visibly highlighted).
 *   2. Bump {@link MEET_SELECTOR_VERSION} (date-stamped) and update the
 *      query strings in {@link MEET_DOM_QUERIES} to match the new DOM.
 *   3. Add/adjust the fixture test asserting `listParticipants` +
 *      `readActiveSpeakers` parse the new fixture; keep the OLD fixture test too
 *      where feasible (resilience across a rollout).
 *   4. The reported `selectorVersion` (sent in the `hello` envelope) lets the app
 *      surface which selector build is live, so a regression is attributable.
 */

/** Date-stamped version of the selector logic; sent to the app in `hello`. Bump on every DOM-selector change. */
export const MEET_SELECTOR_VERSION = "2026-06-24" as const;

/**
 * One participant as read from Meet's participant UI. `name` is the raw display
 * name (may carry " (You)" / presenter suffixes — the app normalizes). `speaking`
 * reflects the active-speaker indicator state for that participant AT READ TIME,
 * or null when the indicator couldn't be read for them (treated as "unknown",
 * not "silent").
 */
export interface MeetParticipantReading {
  name: string;
  /** true = active-speaker indicator on; false = off; null = couldn't determine. */
  speaking: boolean | null;
}

/**
 * The swappable selector surface. Both methods are TOTAL (never throw):
 *  - `listParticipants` returns the current participant names (best-effort; `[]`
 *    when the panel can't be read).
 *  - `readActiveSpeakers` returns each participant's current speaking state
 *    (best-effort; `[]` when the indicator can't be read). The content script
 *    diffs successive readings to emit `{ts,name,speaking}` toggle events.
 */
export interface MeetSelectors {
  /** Date-stamped selector version (defaults to {@link MEET_SELECTOR_VERSION}). */
  readonly version: string;
  /** Current participant names. Total: `[]` on any read failure (never throws). */
  listParticipants(root: ParentNode): string[];
  /** Current per-participant speaking state. Total: `[]` on failure (never throws). */
  readActiveSpeakers(root: ParentNode): MeetParticipantReading[];
}

/**
 * SIGNATURE the production implementation matches: construct the DOM-backed
 * {@link MeetSelectors} (queries live Meet markup). It is the ONLY module
 * allowed to embed raw Meet selector strings. Tests construct it the same way
 * and feed it a parsed fixture `root` — NEVER a live Meet page.
 */
export type CreateDomMeetSelectors = () => MeetSelectors;

/**
 * Every Meet DOM query the selectors depend on, gathered in ONE table so a DOM
 * change is a localized edit (per the update process above). Each entry lists
 * MULTIPLE candidate selectors tried in order — Meet rolls out DOM variants
 * gradually, so a list lets the same build read both the old and new markup
 * during a rollout. All are best-effort; a miss yields `[]`/`null`, never a throw.
 *
 * Notes on what each targets (as of {@link MEET_SELECTOR_VERSION}):
 *  - `participantRows`: the rows of the People/participant panel. Meet renders
 *    each participant in a list item carrying `role="listitem"` and a
 *    `data-participant-id`; we also accept the tile container in the call grid
 *    (`[data-participant-id]`) as a fallback when the panel is closed.
 *  - `participantName`: within a row, the element bearing the display name. Meet
 *    has used `[data-self-name]`, a `.zWGUib` name span, and `[data-tooltip]`;
 *    we also fall back to the row's own text content.
 *  - `speakingActiveOnRow`: marker that a row is CURRENTLY the active speaker.
 *    Meet toggles a class on an animated "speaking" ring; the class names are
 *    obfuscated + churn, so we match on the stable-ish `aria-label`/`jsname`
 *    hooks and a data attribute when present, plus a known class as a last resort.
 */
export const MEET_DOM_QUERIES = {
  /** Candidate selectors for one participant row/tile. Tried in order. */
  participantRows: [
    'div[role="listitem"][data-participant-id]',
    "div[data-participant-id]",
    '[role="listitem"][aria-label]',
  ],
  /** Within a row, candidate selectors for the display-name element. Tried in order. */
  participantName: [
    "[data-self-name]",
    "span.zWGUib",
    "[data-tooltip]",
    "[aria-label]",
  ],
  /**
   * Within a row, candidate selectors that, when MATCHED, mean the row is the
   * active speaker right now. Tried in order; a match => speaking.
   */
  speakingActiveOnRow: [
    "[data-is-speaking='true']",
    "div.IisKdb",
    "[jsname='Wd9bO'].Hr3iWb",
  ],
  /**
   * Candidate attributes (in priority order) read off a row to recover the
   * display name when no dedicated name element matches. Each entry is an
   * attribute name; the first present non-empty value wins before falling back
   * to the row's textContent.
   */
  participantNameAttrs: ["data-self-name", "data-name", "aria-label"],
} as const;

/**
 * Strip Meet's display-name decorations to the bare name. Removes a trailing
 * " (You)" / " (Presentation)" / " (Host)" suffix Meet appends and collapses
 * whitespace. Pure + total — `""`/whitespace in yields `""` out. Normalization
 * to a canonical form for correlation is the engine's job; this only trims the
 * obviously-non-name chrome so the wire carries a clean-ish display name.
 */
export function cleanDisplayName(raw: string | null | undefined): string {
  if (!raw) return "";
  let name = String(raw).replace(/\s+/g, " ").trim();
  // Drop a single trailing parenthetical suffix Meet appends to a name.
  name = name.replace(/\s*\((?:you|presentation|host|presenting)\)\s*$/i, "").trim();
  return name;
}

/**
 * Try each candidate selector in order against `root.querySelectorAll`; return
 * the matches from the FIRST selector that yields any. Total: a thrown selector
 * (e.g. an invalid query on an exotic engine) or a missing method yields `[]`.
 */
function queryFirst(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const sel of selectors) {
    try {
      const found = root.querySelectorAll?.(sel);
      if (found && found.length > 0) {
        return Array.from(found) as Element[];
      }
    } catch {
      // Bad/unsupported selector on this engine — try the next candidate.
    }
  }
  return [];
}

/** Does any candidate selector match WITHIN this element? Total: false on error. */
function matchesAny(el: Element, selectors: readonly string[]): boolean {
  for (const sel of selectors) {
    try {
      if (el.querySelector?.(sel)) return true;
      // Some markers live ON the row element itself, not a descendant.
      if (typeof el.matches === "function" && el.matches(sel)) return true;
    } catch {
      // Ignore an unsupported selector and try the next.
    }
  }
  return false;
}

/**
 * Map a name-element selector to the attribute its name lives in (when the name
 * is carried as an attribute value, e.g. `[data-tooltip]`, rather than as the
 * element's text). Selectors whose name is the visible text map to `null`.
 */
const NAME_SELECTOR_ATTR: Record<string, string | null> = {
  "[data-self-name]": "data-self-name",
  "span.zWGUib": null,
  "[data-tooltip]": "data-tooltip",
  "[aria-label]": "aria-label",
};

/** Read the display name out of one participant row. Total: `""` when unreadable. */
function readNameFromRow(row: Element): string {
  // 1. A dedicated name element: prefer its text, else the attribute it carries.
  for (const sel of MEET_DOM_QUERIES.participantName) {
    try {
      const el = row.querySelector?.(sel);
      if (!el) continue;
      const text = cleanDisplayName(el.textContent ?? "");
      if (text) return text;
      const attr = NAME_SELECTOR_ATTR[sel];
      if (attr) {
        const fromAttr = cleanDisplayName(el.getAttribute?.(attr) ?? "");
        if (fromAttr) return fromAttr;
      }
    } catch {
      // try next
    }
  }
  // 2. A name-bearing attribute on the row itself.
  for (const attr of MEET_DOM_QUERIES.participantNameAttrs) {
    try {
      const v = cleanDisplayName(row.getAttribute?.(attr) ?? "");
      if (v) return v;
    } catch {
      // try next
    }
  }
  // 3. Fall back to the row's own visible text.
  try {
    return cleanDisplayName(row.textContent ?? "");
  } catch {
    return "";
  }
}

/**
 * The production DOM-backed selectors. The ONLY module embedding raw Meet
 * selector strings ({@link MEET_DOM_QUERIES}). Every read is wrapped so a miss or
 * a thrown DOM call degrades to `[]`/`null` — it NEVER throws into Meet.
 */
export const createDomMeetSelectors: CreateDomMeetSelectors = () => ({
  version: MEET_SELECTOR_VERSION,

  listParticipants(root: ParentNode): string[] {
    try {
      if (!root) return [];
      const rows = queryFirst(root, MEET_DOM_QUERIES.participantRows);
      const names: string[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const name = readNameFromRow(row);
        if (name && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
      return names;
    } catch (err) {
      // Total: a structural change that breaks even the wrapper degrades to [].
      console.warn("[loqui-extension] listParticipants degraded:", err);
      return [];
    }
  },

  readActiveSpeakers(root: ParentNode): MeetParticipantReading[] {
    try {
      if (!root) return [];
      const rows = queryFirst(root, MEET_DOM_QUERIES.participantRows);
      const readings: MeetParticipantReading[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const name = readNameFromRow(row);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        let speaking: boolean | null;
        try {
          speaking = matchesAny(row, MEET_DOM_QUERIES.speakingActiveOnRow);
        } catch {
          // Couldn't read the indicator for this row — unknown, not silent.
          speaking = null;
        }
        readings.push({ name, speaking });
      }
      return readings;
    } catch (err) {
      console.warn("[loqui-extension] readActiveSpeakers degraded:", err);
      return [];
    }
  },
});
