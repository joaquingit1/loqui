/**
 * PRD-6 — the PURE speaker-name correlation engine (main side).
 *
 * Given the diarized transcript (PRD-5: the system-stream `Speaker N` turns) and
 * the buffered Meet active-speaker {@link SpeakerActivityEvent}s, map each
 * `Speaker N` label to the participant `name` whose speaking intervals best
 * overlap that speaker's turn intervals — confidence-aware, ambiguity-safe.
 *
 * CLOCK RECONCILIATION (documented in @loqui/shared): activity `ts` is epoch ms
 * (`Date.now()` in the content script); diarized turns are seconds from meeting
 * start. We anchor activity to the same seconds-from-start axis by subtracting
 * `params.meetingStartEpochMs` and dividing by 1000, then absorb extension/
 * meeting clock drift by widening each speaking interval by `skewToleranceMs`
 * on both ends when measuring overlap.
 *
 * PURITY (non-negotiable): NO I/O, NO Date.now, NO randomness. The result is a
 * deterministic function of (diarized, activity, params) so the engine is fully
 * fixture-driven. It NEVER throws on weird input — malformed/empty inputs yield
 * an empty (apply-nothing) result; ambiguous/low-confidence mappings carry
 * `apply: false` and the applier leaves that speaker as `Speaker N`.
 *
 * GRACEFUL DEGRADATION: an empty `activity`, or activity for participants who
 * never overlap the system turns, yields an empty/low-confidence result =>
 * generic labels are kept. "You" (the mic) is never resolved here.
 */
import {
  SPEAKER_YOU_LABEL,
  speakerCorrelationParamsSchema,
  speakerCorrelationResultSchema,
  type DiarizedTranscript,
  type SpeakerActivityEvent,
  type SpeakerCorrelationParams,
  type SpeakerCorrelationResult,
  type SpeakerNameResolution,
} from "@loqui/shared";

/** A half-open `[start, end)` interval in seconds-from-start. */
interface Interval {
  start: number;
  end: number;
}

/** Overlap (in seconds) of two intervals; 0 when disjoint. */
function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Normalize a raw Meet display name for matching/output: trim, collapse inner
 * whitespace, and strip a trailing " (You)" / "(Presentation)" style suffix Meet
 * appends. Keeps the human name. Total — empty in => empty out.
 */
function normalizeName(raw: string): string {
  let name = (raw ?? "").replace(/\s+/g, " ").trim();
  // Strip a trailing parenthetical suffix Meet adds (" (You)", " (Presenter)",
  // "(Presentation)", localized variants). Only when it is a *suffix* so a real
  // name containing parens mid-string is preserved.
  name = name.replace(/\s*\([^)]*\)\s*$/u, "").trim();
  return name;
}

/**
 * Build each participant's speaking intervals (seconds-from-start) from the
 * activity stream. An activity event toggles a participant's speaking state at
 * `ts`; we pair each `speaking:true` with the next `speaking:false` for the same
 * participant (or the last observed ts when a close is missing). Events are
 * processed in `ts` order (stable). Returns a map normalized-name -> intervals.
 */
function buildSpeakingIntervals(
  activity: SpeakerActivityEvent[],
  meetingStartEpochMs: number,
): Map<string, Interval[]> {
  // Anchor epoch-ms ts to seconds-from-start. The meeting start MUST be known:
  // the diarized turns live on a seconds-from-start axis whose origin is the
  // meeting start, so without a finite anchor we cannot place activity against
  // them. We DO NOT fall back to the earliest event — doing so can shift a late
  // first event to engine-t=0 and CONFIDENTLY MISLABEL a different speaker (a
  // "no bad data" violation of the #1 invariant). An unknown start => no
  // intervals => an empty result => the meeting keeps its generic labels.
  if (!(meetingStartEpochMs > 0)) return new Map<string, Interval[]>();

  const sorted = [...activity]
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => normalizeName(e.name) !== "")
    .sort((x, y) => (x.e.ts === y.e.ts ? x.i - y.i : x.e.ts - y.e.ts));

  const anchorMs = meetingStartEpochMs;
  const toSec = (ts: number): number => (ts - anchorMs) / 1000;

  const lastTs = sorted.length > 0 ? sorted[sorted.length - 1]!.e.ts : anchorMs;
  const intervals = new Map<string, Interval[]>();
  /** Open "speaking since" time (seconds) per participant. */
  const openSince = new Map<string, number>();

  function ensure(name: string): Interval[] {
    let arr = intervals.get(name);
    if (!arr) {
      arr = [];
      intervals.set(name, arr);
    }
    return arr;
  }

  for (const { e } of sorted) {
    const name = normalizeName(e.name);
    const tSec = toSec(e.ts);
    if (e.speaking) {
      // A new speaking start. If one is already open, keep the earliest open
      // (continuation); otherwise open one now.
      if (!openSince.has(name)) openSince.set(name, tSec);
    } else {
      // Speaking stopped: close the open interval if any.
      const since = openSince.get(name);
      if (since !== undefined) {
        if (tSec > since) ensure(name).push({ start: since, end: tSec });
        openSince.delete(name);
      }
    }
  }
  // Close any still-open intervals at the last observed timestamp.
  const lastSec = toSec(lastTs);
  for (const [name, since] of openSince) {
    if (lastSec > since) ensure(name).push({ start: since, end: lastSec });
  }
  return intervals;
}

/**
 * The PURE correlation engine. See the module header for the contract.
 */
export function correlateSpeakerNames(
  diarized: DiarizedTranscript,
  activity: SpeakerActivityEvent[],
  params?: SpeakerCorrelationParams,
): SpeakerCorrelationResult {
  // Validate/default params + tolerate a missing diarized/activity (never throw).
  const p = speakerCorrelationParamsSchema.parse(params ?? {});
  const segments = Array.isArray(diarized?.segments) ? diarized.segments : [];
  const meetingId = diarized?.meetingId ?? "";
  const events = Array.isArray(activity) ? activity : [];

  // The skew tolerance (seconds) widens each speaking interval on both ends.
  const skewSec = p.skewToleranceMs / 1000;
  const minOverlapSec = p.minOverlapMs / 1000;

  // Per system-stream speaker: its turn intervals (seconds-from-start). "You"
  // (mic) is never resolved here. Use first-appearance order for stable output.
  const speakerOrder: string[] = [];
  const speakerTurns = new Map<string, Interval[]>();
  let totalSystemTurnSec = 0;
  for (const seg of segments) {
    const label = seg.speaker ?? "";
    if (label === "" || label === SPEAKER_YOU_LABEL) continue;
    const start = Number.isFinite(seg.tStart) ? seg.tStart : 0;
    const end = Number.isFinite(seg.tEnd) ? seg.tEnd : start;
    if (end <= start) continue;
    if (!speakerTurns.has(label)) {
      speakerTurns.set(label, []);
      speakerOrder.push(label);
    }
    speakerTurns.get(label)!.push({ start, end });
    totalSystemTurnSec += end - start;
  }

  const speakingIntervals = buildSpeakingIntervals(events, p.meetingStartEpochMs);
  const participantNames = [...speakingIntervals.keys()];

  // For each speaker, score each participant by total overlapping seconds (the
  // participant's intervals widened by skew tolerance). Resolve to the best
  // participant; ambiguity (a close runner-up) or thin evidence => apply:false.
  const resolutions: SpeakerNameResolution[] = [];
  let coveredSystemTurnSec = 0;

  for (const speaker of speakerOrder) {
    const turns = speakerTurns.get(speaker)!;
    const speakerTurnSec = turns.reduce((s, t) => s + (t.end - t.start), 0);

    // name -> overlapping seconds with this speaker's turns.
    const scores = new Map<string, number>();
    for (const name of participantNames) {
      const widened = speakingIntervals
        .get(name)!
        .map((iv): Interval => ({ start: iv.start - skewSec, end: iv.end + skewSec }));
      let sec = 0;
      for (const turn of turns) {
        for (const iv of widened) sec += overlap(turn, iv);
      }
      // Clamp per-speaker overlap to the speaker's own turn time (skew-widened
      // intervals can otherwise double-count past the turn duration).
      if (sec > speakerTurnSec) sec = speakerTurnSec;
      if (sec > 0) scores.set(name, sec);
    }

    // Best + runner-up.
    let bestName = "";
    let bestSec = 0;
    let secondSec = 0;
    for (const [name, sec] of scores) {
      if (sec > bestSec) {
        secondSec = bestSec;
        bestSec = sec;
        bestName = name;
      } else if (sec > secondSec) {
        secondSec = sec;
      }
    }

    // Confidence: the best participant's share of the speaker's turn time,
    // discounted by ambiguity (how close the runner-up is). A clean, dominant
    // match -> ~1; a contested match -> lower. Defined deterministically.
    const coverage = speakerTurnSec > 0 ? Math.min(1, bestSec / speakerTurnSec) : 0;
    const dominance = bestSec > 0 ? 1 - secondSec / bestSec : 0;
    const confidence = Math.max(0, Math.min(1, coverage * dominance));

    const enoughEvidence = bestSec >= minOverlapSec && bestName !== "";
    const apply = enoughEvidence && confidence >= p.confidenceThreshold;
    if (apply) coveredSystemTurnSec += speakerTurnSec;

    resolutions.push({
      speaker,
      name: bestName,
      confidence,
      support: Math.round(bestSec * 1000),
      apply,
    });
  }

  const coveragePct =
    totalSystemTurnSec > 0
      ? Math.max(0, Math.min(1, coveredSystemTurnSec / totalSystemTurnSec))
      : 0;

  return speakerCorrelationResultSchema.parse({
    meetingId,
    resolutions,
    participants: participantNames,
    usedActivityEvents: events.length,
    coveragePct,
  });
}
