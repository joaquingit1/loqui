/**
 * PRD-6 — the Meet active-speaker WATCHER (pure-ish, injectable).
 *
 * Drives the swappable {@link MeetSelectors} on a cadence, DIFFs each reading
 * against the previous one, and emits ONE `activity` {ts, name, speaking} per
 * toggle through the injected {@link MeetEventSender}. Factored out of the
 * content-script entry so the diff/gate logic is unit-testable with a fake
 * selectors object + fake sender + a manual clock — NO browser, NO DOM library.
 *
 * #1 INVARIANT — NEVER THROW. Every tick is wrapped: a selector miss (`[]`/null)
 * means "couldn't read this tick" and emits nothing; a thrown read is swallowed
 * and logged. The watcher only READS names + the speaking indicator (never
 * audio) and only emits while it has been `start()`ed.
 *
 * CLOCK CONVENTION: `ts` is epoch ms from the injected `now()` (Date.now() in
 * production) — main reconciles it against the diarized seconds-from-start axis.
 */
import type { ExtensionMessage } from "@loqui/shared";
import type { MeetEventSender } from "../ws-client.js";
import type { MeetSelectors } from "./selectors.js";

/** A name->speaking snapshot taken one tick. `null` speaking = "couldn't read". */
type SpeakingState = Map<string, boolean | null>;

export interface MeetWatcher {
  /** Begin ticking (idempotent). */
  start(): void;
  /** Stop ticking + clear diff state (idempotent). Does NOT close the sender. */
  stop(): void;
  /** Run one read/diff/emit cycle. Exposed for tests + the interval/observer. */
  tick(): void;
}

export interface MeetWatcherDeps {
  /** The swappable selectors (the ONLY DOM-touching module). */
  selectors: MeetSelectors;
  /** The WS sender activity frames go out on. */
  sender: MeetEventSender;
  /**
   * Resolve the participant-panel root to read this tick, or null when there's
   * nothing to read (panel closed / not in a call). A null root => emit nothing.
   */
  getRoot: () => ParentNode | null;
  /** Wall clock for event `ts` (epoch ms). Defaults to Date.now in the entry. */
  now: () => number;
}

/**
 * Compare the previous and current speaking snapshots and return the toggle
 * events to emit. PURE — no I/O. Rules (graceful, conservative):
 *  - A participant whose `speaking` flips false/unknown -> true emits
 *    `{name, speaking:true}`; true -> false emits `{name, speaking:false}`.
 *  - `null` (couldn't read the indicator for that row this tick) is treated as
 *    "unknown": it neither starts nor stops; we hold the last known state to
 *    avoid spurious stop/start churn from a transient read miss.
 *  - A participant who DISAPPEARS from the reading while last-known-speaking
 *    emits a synthetic `{speaking:false}` so a turn never dangles open.
 */
export function diffSpeaking(
  prev: SpeakingState,
  curr: SpeakingState,
): Array<{ name: string; speaking: boolean }> {
  const out: Array<{ name: string; speaking: boolean }> = [];

  for (const [name, currVal] of curr) {
    if (currVal === null) continue; // unknown this tick — hold prior state.
    const prevVal = prev.get(name) ?? false;
    const wasSpeaking = prevVal === true;
    if (currVal === true && !wasSpeaking) out.push({ name, speaking: true });
    else if (currVal === false && wasSpeaking) out.push({ name, speaking: false });
  }

  // Anyone who was speaking and vanished from the reading => close their turn.
  for (const [name, prevVal] of prev) {
    if (prevVal === true && !curr.has(name)) {
      out.push({ name, speaking: false });
    }
  }

  return out;
}

/**
 * Merge a fresh reading into the carried state. A `null` (unreadable) indicator
 * for a known participant HOLDS the previous value rather than overwriting it,
 * so a one-tick read miss doesn't manufacture a stop/start. New participants
 * with a `null` indicator start as `false` (assume not speaking until seen so).
 */
export function mergeSpeakingState(
  prev: SpeakingState,
  curr: SpeakingState,
): SpeakingState {
  const next: SpeakingState = new Map();
  for (const [name, currVal] of curr) {
    if (currVal === null) {
      next.set(name, prev.get(name) ?? false);
    } else {
      next.set(name, currVal);
    }
  }
  return next;
}

export function createMeetWatcher(deps: MeetWatcherDeps): MeetWatcher {
  const { selectors, sender, getRoot, now } = deps;
  let running = false;
  let state: SpeakingState = new Map();

  function tick(): void {
    if (!running) return;
    try {
      const root = getRoot();
      if (!root) {
        // Not in a call / panel unavailable: close any open turns, go quiet.
        if (state.size > 0) {
          const empty: SpeakingState = new Map();
          for (const ev of diffSpeaking(state, empty)) {
            emit(ev.name, ev.speaking);
          }
          state = empty;
        }
        return;
      }
      const readings = selectors.readActiveSpeakers(root);
      const curr: SpeakingState = new Map();
      for (const r of readings) {
        if (r.name) curr.set(r.name, r.speaking);
      }
      for (const ev of diffSpeaking(state, curr)) {
        emit(ev.name, ev.speaking);
      }
      state = mergeSpeakingState(state, curr);
    } catch (err) {
      // A read/diff failure must never propagate into Meet.
      console.warn("[loqui-extension] watcher tick degraded:", err);
    }
  }

  function emit(name: string, speaking: boolean): void {
    const msg: ExtensionMessage = {
      type: "activity",
      event: { ts: now(), name, speaking },
    };
    sender.send(msg);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      state = new Map();
    },
    stop(): void {
      if (!running) return;
      running = false;
      state = new Map();
    },
    tick,
  };
}
