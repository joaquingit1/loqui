/**
 * Kbd — a tokenized keyboard-hint chip (PRD-16 macOS-skill compliance).
 *
 * Renders a faint, mono `<kbd>` chip showing a shortcut next to its action
 * (e.g. ⌘F in the Library search, ⌘N near Start meeting). It is decorative
 * affordance, not an interactive control: `aria-hidden` so screen readers hear
 * the labelled button, not the glyphs.
 *
 * The chip is styled entirely by the tokenized `.kbd` rule in styles.css
 * (--surface-sunken bg, --radius-sm, --text-faint, mono) — no inline styling.
 * Pass `combo` as the rendered text; callers build it from modKeyLabel() so the
 * glyph matches the active platform (⌘ on macOS, Ctrl elsewhere).
 */
import type { JSX } from "react";

export interface KbdProps {
  /** The chord text to display, e.g. "⌘F", "Ctrl N", "⌘⏎". */
  combo: string;
  /** Extra class for placement tweaks (kept tokenized in feature CSS). */
  className?: string;
}

export function Kbd({ combo, className }: KbdProps): JSX.Element {
  return (
    <kbd className={`kbd${className ? ` ${className}` : ""}`} aria-hidden="true" data-testid="kbd-hint">
      {combo}
    </kbd>
  );
}
