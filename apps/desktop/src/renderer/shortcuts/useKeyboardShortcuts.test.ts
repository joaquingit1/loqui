/**
 * useKeyboardShortcuts + platform tests (jsdom). HERMETIC: pure DOM events, no
 * window.loqui, no Electron. Covers ⌘/Ctrl dispatch, typing safety (plain keys
 * suppressed in fields; mod combos + Esc still fire), shift matching, and the
 * platform glyph helpers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useKeyboardShortcuts, type Shortcut } from "./useKeyboardShortcuts.js";
import { isMacPlatform, modKeyLabel } from "./platform.js";

afterEach(cleanup);

/** Dispatch a keydown on a target (defaults to document.body). */
function press(
  key: string,
  opts: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; target?: Element } = {},
): void {
  const target = opts.target ?? document.body;
  const ev = new KeyboardEvent("keydown", {
    key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
}

describe("platform helpers", () => {
  it("detects mac from navigator.platform / userAgent", () => {
    expect(isMacPlatform({ platform: "MacIntel", userAgent: "" } as Navigator)).toBe(true);
    expect(isMacPlatform({ platform: "Win32", userAgent: "Windows" } as Navigator)).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });

  it("renders ⌘ on mac and Ctrl elsewhere", () => {
    expect(modKeyLabel(true)).toBe("⌘");
    expect(modKeyLabel(false)).toBe("Ctrl");
  });
});

describe("useKeyboardShortcuts", () => {
  it("runs a ⌘-chord on mac (metaKey) and ignores Ctrl on mac", () => {
    const run = vi.fn();
    const scs: Shortcut[] = [{ key: "n", mod: true, run }];
    renderHook(() => useKeyboardShortcuts(scs, { isMac: true }));

    press("n", { meta: true });
    expect(run).toHaveBeenCalledTimes(1);

    // Ctrl on mac is the WRONG modifier — must not fire (don't shadow OS chords).
    press("n", { ctrl: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs a Ctrl-chord off mac and ignores meta off mac", () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "f", mod: true, run }], { isMac: false }));

    press("f", { ctrl: true });
    expect(run).toHaveBeenCalledTimes(1);

    press("f", { meta: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does NOT hijack plain typing in an input, but Escape still fires", () => {
    const esc = vi.fn();
    const plain = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts(
        [
          { key: "Escape", run: esc },
          { key: "f", run: plain },
        ],
        { isMac: true },
      ),
    );

    const input = document.createElement("input");
    document.body.appendChild(input);

    // A plain "f" while focused in a field is typing — suppressed.
    press("f", { target: input });
    expect(plain).not.toHaveBeenCalled();

    // Escape always fires (dismiss-from-anywhere).
    press("Escape", { target: input });
    expect(esc).toHaveBeenCalledTimes(1);

    input.remove();
  });

  it("fires a mod-chord even while typing in a field (⌘F focus convention)", () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "f", mod: true, run }], { isMac: true }));

    const input = document.createElement("input");
    document.body.appendChild(input);
    press("f", { meta: true, target: input });
    expect(run).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("respects an explicit shift requirement", () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "Enter", mod: true, shift: false, run }], { isMac: true }));

    press("Enter", { meta: true, shift: true });
    expect(run).not.toHaveBeenCalled();
    press("Enter", { meta: true, shift: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled", () => {
    const run = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "1", mod: true, run }], { isMac: true, enabled: false }));
    press("1", { meta: true });
    expect(run).not.toHaveBeenCalled();
  });
});
