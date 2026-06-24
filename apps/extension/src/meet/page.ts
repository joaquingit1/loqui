/**
 * PRD-6 — small browser-context helpers for the Meet page.
 *
 * Pure where possible (URL parsing) so it's unit-testable; the DOM-root resolver
 * is best-effort and total. These are deliberately OUTSIDE selectors.ts because
 * they read the URL / call-state, not Meet's participant markup — but they follow
 * the same #1 INVARIANT: never throw into the page, degrade to a safe default.
 */

/**
 * Extract Meet's meeting code from a URL path (e.g. "abc-defg-hij" from
 * https://meet.google.com/abc-defg-hij). PURE + total: returns null for the
 * landing page, lobby, or any path that isn't a meeting code. Conservative
 * pattern (lowercase letters in xxx-xxxx-xxx groups) so we don't mislabel
 * routes like /new or /landing as a code.
 */
export function parseMeetingCode(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.hostname !== "meet.google.com") return null;
    const seg = url.pathname.replace(/^\/+|\/+$/g, "");
    // Meet codes look like 3-4-3 lowercase letter groups.
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(seg)) return seg;
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether the page currently looks like an ACTIVE call (vs. the lobby/landing).
 * Best-effort + total: used only to gate emitting, and the watcher's getRoot
 * already returns null when there's nothing to read, so a false positive here is
 * harmless (we just read an empty panel and emit nothing).
 */
export function isInCall(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  try {
    // The presence of any participant tile/row is a reliable "in a call" signal.
    return (
      doc.querySelector?.("[data-participant-id]") != null ||
      doc.querySelector?.('div[role="listitem"][data-participant-id]') != null
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the DOM subtree to read participants from. Best-effort + total: prefers
 * the People panel container, falls back to the whole document. Returns null when
 * there's no document (non-browser context) so the watcher emits nothing.
 */
export function resolveParticipantRoot(doc: Document | null | undefined): ParentNode | null {
  if (!doc) return null;
  try {
    // The People/participant panel, when open, is the tightest scope.
    const panel =
      doc.querySelector?.('[role="list"][aria-label]') ??
      doc.querySelector?.('div[jsname][role="list"]');
    if (panel) return panel;
    // Fall back to the document so call-grid tiles are still readable.
    return doc;
  } catch {
    return doc ?? null;
  }
}
