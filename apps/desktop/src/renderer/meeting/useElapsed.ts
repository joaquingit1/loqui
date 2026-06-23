/**
 * Live elapsed-time ticker for the recording status (PRD-3).
 *
 * Given a meeting's ISO `startedAt` and whether it is still running, returns the
 * elapsed seconds, re-rendering once per second while active. When stopped, it
 * freezes at the final duration (computed against `endedAt` if given, else the
 * moment it stopped ticking).
 *
 * The clock (`now`) and the interval scheduler are injectable so tests are
 * deterministic and don't depend on real timers.
 */
import { useEffect, useRef, useState } from "react";

export interface UseElapsedOptions {
  /** ISO-8601 meeting start; null/undefined ⇒ 0 elapsed. */
  startedAt?: string | null;
  /** ISO-8601 meeting end; when set, the elapsed value is frozen to it. */
  endedAt?: string | null;
  /** Whether the meeting is actively recording (drives the per-second tick). */
  running: boolean;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

function parseMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole seconds elapsed since start, clamped at 0. */
function computeElapsed(startMs: number | null, endMs: number): number {
  if (startMs == null) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

export function useElapsed(options: UseElapsedOptions): number {
  const { startedAt, endedAt, running } = options;
  const now = options.now ?? Date.now;

  const startMs = parseMs(startedAt);
  const endMs = parseMs(endedAt);

  const nowRef = useRef(now);
  nowRef.current = now;

  const [elapsed, setElapsed] = useState<number>(() =>
    computeElapsed(startMs, endMs ?? now()),
  );

  useEffect(() => {
    // Frozen: not running. Pin to endedAt if known, else the current clock.
    if (!running) {
      setElapsed(computeElapsed(startMs, endMs ?? nowRef.current()));
      return;
    }
    // Recompute immediately, then once per second.
    setElapsed(computeElapsed(startMs, nowRef.current()));
    const handle = setInterval(() => {
      setElapsed(computeElapsed(startMs, nowRef.current()));
    }, 1000);
    return () => clearInterval(handle);
  }, [startMs, endMs, running]);

  return elapsed;
}

/** Format whole seconds as `m:ss` (or `h:mm:ss` past an hour). */
export function formatElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
