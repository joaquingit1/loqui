/**
 * Pure exponential-backoff-with-jitter helper for the sidecar supervisor's
 * restart loop. Kept dependency-free and deterministic (the random source is
 * injectable) so it can be unit-tested without timers, sockets, or env.
 */

export interface BackoffOptions {
  /** Delay for the first retry, in ms. */
  baseDelayMs: number;
  /** Hard cap on any single delay, in ms. */
  maxDelayMs: number;
  /** Multiplier applied per attempt (>= 1). */
  factor: number;
  /**
   * Jitter ratio in [0, 1]. The computed (capped) delay is multiplied by a
   * random factor in `[1 - jitter, 1 + jitter]`. 0 disables jitter.
   */
  jitter: number;
  /**
   * Maximum number of restart attempts before the supervisor gives up and
   * enters the terminal error state. Must be >= 0.
   */
  maxRetries: number;
}

/** Sensible defaults for the sidecar restart loop. */
export const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: 0.2,
  maxRetries: 6,
};

/**
 * The deterministic (pre-jitter) delay for a zero-based `attempt`:
 * `min(maxDelayMs, baseDelayMs * factor**attempt)`. Never negative.
 */
export function backoffBaseDelay(attempt: number, opts: BackoffOptions): number {
  if (attempt < 0) throw new RangeError(`attempt must be >= 0, got ${attempt}`);
  const raw = opts.baseDelayMs * Math.pow(opts.factor, attempt);
  // Guard against Infinity/NaN from extreme attempts before clamping.
  const bounded = Number.isFinite(raw) ? raw : opts.maxDelayMs;
  return Math.min(opts.maxDelayMs, Math.max(0, bounded));
}

/**
 * The actual delay to wait before retry `attempt` (zero-based), applying
 * jitter. `rand` returns a float in [0, 1) (defaults to Math.random); inject a
 * fixed value in tests for determinism. The result is clamped to
 * `[0, maxDelayMs]` so a +jitter excursion can never exceed the cap by more
 * than the jitter ratio — and is then re-clamped to the cap.
 */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions,
  rand: () => number = Math.random,
): number {
  const base = backoffBaseDelay(attempt, opts);
  if (opts.jitter <= 0) return base;
  const span = opts.jitter; // +/- ratio
  // rand in [0,1) -> factor in [1 - span, 1 + span)
  const factor = 1 - span + rand() * (2 * span);
  const jittered = base * factor;
  return Math.min(opts.maxDelayMs, Math.max(0, jittered));
}

/** Whether a further retry is permitted for a zero-based `attempt`. */
export function shouldRetry(attempt: number, opts: BackoffOptions): boolean {
  return attempt < opts.maxRetries;
}
