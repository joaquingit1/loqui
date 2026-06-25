/**
 * Platform detection + keyboard-glyph helpers (PRD-16 macOS-skill compliance).
 *
 * Loqui is macOS-primary but cross-platform (Windows 10+). Keyboard shortcuts
 * follow Apple conventions on macOS (⌘) and the native Ctrl convention
 * elsewhere; this module is the single place that decides which, so the hook and
 * the visible <kbd> hints stay in lock-step.
 *
 * Detection is renderer-safe: it reads only `navigator` (no Node, no
 * window.loqui), and degrades to non-mac when navigator is unavailable (e.g. a
 * bare unit render), which keeps tests deterministic.
 */

/** True on macOS — drives ⌘ vs Ctrl for both the handler and the hints. */
export function isMacPlatform(nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  if (!nav) return false;
  // navigator.platform is deprecated but still the most reliable signal in
  // Electron's Chromium; fall back to the userAgent for safety.
  const probe = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`.toLowerCase();
  return probe.includes("mac");
}

/**
 * The primary-modifier glyph for the current platform: "⌘" on macOS, "Ctrl"
 * elsewhere. Used to render <kbd> hints that match the active binding.
 */
export function modKeyLabel(mac: boolean = isMacPlatform()): string {
  return mac ? "⌘" : "Ctrl";
}

/** The Return/Enter glyph (⏎) — used by the ⌘↩ send hint. */
export const RETURN_GLYPH = "⏎";
