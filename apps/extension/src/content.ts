/**
 * PRD-6 — Google Meet content-script ENTRY.
 *
 * Bundled by scripts/build.ts (esbuild -> IIFE) into dist/content.js, the single
 * script the MV3 manifest injects on https://meet.google.com/*. It:
 *   1. constructs the swappable {@link createDomMeetSelectors} — the ONLY thing
 *      that touches Meet's DOM;
 *   2. opens a loopback WS to the Loqui app ({@link createMeetEventSender} —
 *      host/port/path pinned by @loqui/shared SPEAKERNAMES_WS_* constants) and
 *      sends `hello` (extension + selector version, meeting code from the URL,
 *      origin);
 *   3. on a cadence (a short interval + a MutationObserver on the participant
 *      area), drives {@link createMeetWatcher} to read the active-speaker state,
 *      DIFF it against the previous reading, and send one `activity`
 *      {ts: Date.now(), name, speaking} per toggle — ONLY while in a call;
 *   4. sends `bye` + closes the socket when the page unloads.
 *
 * #1 INVARIANT — NEVER THROW INTO MEET. The whole body runs inside a top-level
 * try/catch (and every selector read is already total); any failure logs to the
 * console and the script goes quiet. A missing selector, a closed socket, or a
 * refused connection (Loqui not running) is normal and silent — Loqui still
 * completes the meeting with generic `Speaker N` labels. NO audio is ever read
 * or recorded here; this script only reads names + the speaking indicator.
 */
import type { ExtensionMessage } from "@loqui/shared";
import { MEET_ORIGIN } from "./contract.js";
import { createDomMeetSelectors, MEET_SELECTOR_VERSION } from "./meet/selectors.js";
import { createMeetWatcher } from "./meet/watcher.js";
import { parseMeetingCode, resolveParticipantRoot } from "./meet/page.js";
import { createMeetEventSender } from "./ws-client.js";

export {};

/** How often to poll the active-speaker indicator (ms). */
const TICK_INTERVAL_MS = 500;

/** Manifest version, injected at build time; "" if the build didn't set it. */
declare const __LOQUI_EXTENSION_VERSION__: string | undefined;

function readExtensionVersion(): string {
  // chrome.runtime is available in the content-script context; fall back to the
  // build-time define, then empty. All reads are guarded — never throw.
  try {
    const v = chrome?.runtime?.getManifest?.()?.version;
    if (v) return v;
  } catch {
    // chrome may be undefined in non-extension contexts (tests) — ignore.
  }
  try {
    if (typeof __LOQUI_EXTENSION_VERSION__ === "string") {
      return __LOQUI_EXTENSION_VERSION__;
    }
  } catch {
    // define not present — ignore.
  }
  return "";
}

function startMeetContentScript(): void {
  const selectors = createDomMeetSelectors();
  const sender = createMeetEventSender();

  // Announce the session so main can associate this tab with the active meeting.
  const hello: ExtensionMessage = {
    type: "hello",
    extensionVersion: readExtensionVersion(),
    selectorVersion: MEET_SELECTOR_VERSION,
    meetingCode: parseMeetingCode(location?.href ?? null),
    origin: location?.origin ?? MEET_ORIGIN,
  };
  sender.send(hello);

  const watcher = createMeetWatcher({
    selectors,
    sender,
    getRoot: () => resolveParticipantRoot(document),
    now: () => Date.now(),
  });
  watcher.start();

  // Cadence 1: a short interval is the reliable backbone (the indicator animates
  // without always mutating attributes the observer would catch).
  const intervalId = setInterval(() => watcher.tick(), TICK_INTERVAL_MS);

  // Cadence 2: a MutationObserver makes toggles feel instant between ticks. It's
  // additive — the interval alone is sufficient, so observer failure is harmless.
  let observer: MutationObserver | null = null;
  try {
    if (typeof MutationObserver !== "undefined" && document?.body) {
      observer = new MutationObserver(() => watcher.tick());
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
        attributeFilter: ["class", "aria-label", "data-is-speaking"],
      });
    }
  } catch (err) {
    console.warn("[loqui-extension] observer setup skipped:", err);
  }

  let torndown = false;
  const teardown = (reason: string): void => {
    if (torndown) return;
    torndown = true;
    try {
      clearInterval(intervalId);
    } catch {
      // ignore
    }
    try {
      observer?.disconnect();
    } catch {
      // ignore
    }
    try {
      watcher.stop();
    } catch {
      // ignore
    }
    try {
      sender.close(reason);
    } catch {
      // ignore
    }
  };

  // Clean teardown on navigation away / tab close.
  try {
    window.addEventListener("pagehide", () => teardown("pagehide"), { once: true });
    window.addEventListener("beforeunload", () => teardown("beforeunload"), {
      once: true,
    });
  } catch (err) {
    console.warn("[loqui-extension] teardown listeners skipped:", err);
  }
}

// Top-level guard: never propagate any failure into the Meet page.
try {
  if (typeof location !== "undefined" && location.host === "meet.google.com") {
    startMeetContentScript();
  }
} catch (err) {
  console.warn("[loqui-extension] content script init skipped:", err);
}
