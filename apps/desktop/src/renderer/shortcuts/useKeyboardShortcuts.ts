/**
 * useKeyboardShortcuts — a small, macOS-correct global shortcut handler
 * (PRD-16 macOS-skill compliance: "primary actions MUST have shortcuts").
 *
 * Registers a single document-level keydown listener and dispatches to the
 * provided handlers. The PRIMARY modifier is ⌘ on macOS and Ctrl elsewhere
 * (see ./platform); a shortcut declares `mod: true` to require it.
 *
 * Typing safety (skill: "respect input focus — don't hijack typing"):
 *   - A *plain* key (no mod) is IGNORED while focus is in a text field
 *     (input/textarea/select/contenteditable) — except Escape, which always
 *     fires so it can dismiss panels/menus from anywhere.
 *   - A modifier combo (⌘/Ctrl + key) ALWAYS fires, even from a field, because
 *     that is exactly the macOS convention (⌘F focuses search while typing,
 *     ⌘↩ sends, etc.).
 *
 * Handlers may call `preventDefault` themselves; when a binding matches we also
 * preventDefault by default so the OS/browser doesn't also act (e.g. ⌘F find).
 * The hook never touches window.loqui — it only wires DOM key events to the
 * caller's callbacks.
 */
import { useEffect } from "react";
import { isMacPlatform } from "./platform.js";

/** A normalized chord. `key` matches KeyboardEvent.key case-insensitively. */
export interface Shortcut {
  /** KeyboardEvent.key to match (e.g. "1", "n", "f", ",", "Enter", "Escape"). */
  key: string;
  /** Require the platform primary modifier (⌘ on macOS, Ctrl elsewhere). */
  mod?: boolean;
  /** Require Shift. Defaults to "don't care" (matches with or without). */
  shift?: boolean;
  /** The action to run when the chord matches. */
  run: () => void;
  /**
   * When true, the chord still fires while a text field is focused even without
   * a modifier. Defaults to false (plain keys are suppressed while typing).
   * Escape is special-cased to always fire regardless of this flag.
   */
  allowInInput?: boolean;
}

/** Is the event target an editable field where plain keystrokes are "typing"? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export interface UseKeyboardShortcutsOptions {
  /** Disable all bindings (e.g. while a modal owns the keyboard). */
  enabled?: boolean;
  /** Override platform detection (tests). Defaults to runtime detection. */
  isMac?: boolean;
}

/**
 * Wire a set of shortcuts to a document keydown listener for the lifetime of
 * the component. `shortcuts` may change between renders; the effect re-binds.
 */
export function useKeyboardShortcuts(
  shortcuts: ReadonlyArray<Shortcut>,
  { enabled = true, isMac }: UseKeyboardShortcutsOptions = {},
): void {
  const mac = isMac ?? isMacPlatform();

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    const onKeyDown = (e: KeyboardEvent): void => {
      // The platform primary modifier: ⌘ (metaKey) on macOS, Ctrl elsewhere.
      const modActive = mac ? e.metaKey : e.ctrlKey;
      // Never treat the *other* primary modifier as a match (e.g. Ctrl on mac)
      // so we don't shadow native browser/OS chords on the wrong platform.
      const wrongMod = mac ? e.ctrlKey : e.metaKey;
      const typing = isTypingTarget(e.target);

      for (const sc of shortcuts) {
        if (sc.key.toLowerCase() !== e.key.toLowerCase()) continue;
        if (sc.mod && (!modActive || wrongMod)) continue;
        if (!sc.mod && (e.metaKey || e.ctrlKey || e.altKey)) continue;
        if (sc.shift !== undefined && sc.shift !== e.shiftKey) continue;

        // Typing safety: a plain (non-mod) chord is suppressed while typing,
        // unless it opts in — Escape always fires so it can dismiss anything.
        const isEscape = e.key === "Escape";
        if (typing && !sc.mod && !sc.allowInInput && !isEscape) continue;

        e.preventDefault();
        sc.run();
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcuts, enabled, mac]);
}
