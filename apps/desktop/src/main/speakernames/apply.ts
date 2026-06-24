/**
 * PRD-6 — the speaker-name applier (main side).
 *
 * Apply a {@link SpeakerCorrelationResult} by REUSING the PRD-5 diarized-rewrite
 * path (the SAME mechanism as `renameSpeaker`): for each resolution whose
 * `apply` is true, set the `displayName` on every diarized segment whose stable
 * `speaker` label matches, rewrite BOTH diarized files via
 * {@link writeDiarizedTranscript} (so the `.md` re-renders with the real name),
 * persist the name into `meta.participants` (the matching `speakerLabel`'s
 * `name`), and re-index the searchable text via {@link buildIndexText}. This is
 * NOT a fork of the rename path — it imports the exact postprocess helpers.
 *
 * INVARIANTS:
 *  - MANUAL renames ALWAYS win: a speaker whose participant already carries a
 *    user-set name (a `name` that differs from its `speakerLabel`) is SKIPPED —
 *    auto-resolution never overwrites a human's choice.
 *  - transcript.live.md / transcript.jsonl stay BYTE-IDENTICAL: this touches
 *    ONLY the derived diarized files + meta.participants + the FTS summary
 *    column, exactly like the rename path. An empty / all-`apply:false` result
 *    is a NO-OP — no file is rewritten at all.
 *  - TOTAL + best-effort: a missing/undiarized meeting yields null (the meeting
 *    keeps its generic labels); the engine output is re-validated, never trusted.
 *
 * Returns the resulting diarized transcript (unchanged when nothing applied), or
 * null when there was nothing to apply against.
 */
import {
  speakerCorrelationResultSchema,
  type DiarizedSegment,
  type DiarizedTranscript,
  type Participant,
  type Summary,
} from "@loqui/shared";
import { buildIndexText } from "../postprocess/render.js";
import { writeDiarizedTranscript } from "../postprocess/writers.js";
import type { SpeakerNameApplier, SpeakerNameApplierStore } from "./types.js";

/**
 * Does this participant carry a user-set (manual) name we must NOT overwrite?
 * A participant whose `name` is non-empty and differs from its `speakerLabel`
 * has been renamed by the user (the PRD-5 rename sets `name` to the friendly
 * label; an un-renamed label has `name === speakerLabel`). Auto-resolution
 * always loses to that.
 */
function hasManualName(participants: Participant[], speakerLabel: string): boolean {
  for (const p of participants) {
    if (p.speakerLabel === speakerLabel) {
      const name = (p.name ?? "").trim();
      return name !== "" && name !== speakerLabel;
    }
  }
  return false;
}

/**
 * Apply the resolved names. See the module header for the full contract.
 */
export const applySpeakerNames: SpeakerNameApplier = (
  store: SpeakerNameApplierStore,
  result,
): DiarizedTranscript | null => {
  // Re-validate the engine output (defense in depth; never trust it blindly).
  const parsed = speakerCorrelationResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const { meetingId, resolutions } = parsed.data;

  const diarized = store.getDiarizedTranscript(meetingId);
  if (!diarized) return null; // not diarized yet => keep generic labels.

  const current = store.getMeeting(meetingId);
  const existingParticipants = current?.participants ?? [];

  // Filter to the resolutions we will actually apply: apply=true, a non-empty
  // name, the speaker exists in the transcript, and NOT manually renamed.
  const speakerLabels = new Set(diarized.segments.map((s) => s.speaker));
  const toApply = resolutions.filter((r) => {
    const name = r.name.trim();
    if (!r.apply || name === "" || r.speaker === "") return false;
    if (!speakerLabels.has(r.speaker)) return false;
    if (hasManualName(existingParticipants, r.speaker)) return false;
    return true;
  });

  // NO-OP when nothing to apply: do not rewrite any file (so transcript.live.md
  // and even the diarized files stay byte-identical). Return the current diarized.
  if (toApply.length === 0) return diarized;

  const nameBySpeaker = new Map<string, string>();
  for (const r of toApply) nameBySpeaker.set(r.speaker, r.name.trim());

  // Set displayName on every matching segment (stable label preserved so a
  // future re-diarize/rename can re-apply by label).
  const segments: DiarizedSegment[] = diarized.segments.map((seg) => {
    const name = nameBySpeaker.get(seg.speaker);
    return name !== undefined ? { ...seg, displayName: name } : seg;
  });
  const updated: DiarizedTranscript = { ...diarized, segments };

  // Rewrite the derived diarized files (json + re-rendered md). Atomic — the
  // SAME writer the rename path uses. Never touches the live transcript.
  writeDiarizedTranscript(updated);

  // Persist into meta.participants: the participant mapped to each resolved
  // label gets the real name. Merge by speakerLabel so we never duplicate rows;
  // a label with no existing participant gets a new one.
  if (current) {
    const byLabel = new Map<string, Participant>();
    for (const part of existingParticipants) {
      if (part.speakerLabel) byLabel.set(part.speakerLabel, part);
    }
    const participants = existingParticipants.map((part) => {
      const name = part.speakerLabel ? nameBySpeaker.get(part.speakerLabel) : undefined;
      return name !== undefined ? { ...part, name } : part;
    });
    for (const [label, name] of nameBySpeaker) {
      if (!byLabel.has(label)) {
        participants.push({ id: label, name, speakerLabel: label });
      }
    }
    store.updateMeeting(meetingId, { participants });
  }

  // Re-index the diarized + summary searchable text so search reflects the
  // resolved names (READ-ONLY over the live transcript: only the FTS summary col).
  const summary: Summary | null = store.getSummary(meetingId);
  store.upsertSearchText({ meetingId, summary: buildIndexText(updated, summary) });

  return updated;
};
