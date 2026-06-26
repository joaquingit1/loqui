/**
 * Post-processing pipeline orchestrator (PRD-5, main side).
 *
 * Import as: `import { createPostProcessPipeline } from "../postprocess/pipeline.js"`
 *
 * This is the MAIN-process half of PRD-5 post-processing. It does NOT run
 * diarization/summary itself (that is the sidecar) and it NEVER writes the live
 * transcript. It only:
 *
 *   1) On meeting stop — the controller's `postProcess` hook calls
 *      {@link PostProcessPipeline.onMeetingProcessing} with the `processing`
 *      Meeting. The pipeline waits for the existing `audioFinalized` WS signal
 *      (so the sidecar never reads a still-open/0-byte system.wav on Windows),
 *      then sends ONE `postProcess` WS request to the sidecar carrying the
 *      meeting id + the SAME provider config + transient summary api key + the
 *      transient HF token (both injected out of band from the keystores, never
 *      logged/persisted by main and never sent to the renderer).
 *
 *   2) While the sidecar runs — it emits `jobUpdate` notifications (kind
 *      "diarization" | "summary"); a separate bridge ({@link forwardJobUpdates})
 *      relays those to the renderer. (Kept here as the canonical owner of the
 *      postprocess WS contract.)
 *
 *   3) On completion — the sidecar emits `postProcessDone` carrying the
 *      discovered speakers + the searchable index text + per-stage outcomes (the
 *      derived files themselves are already written by the sidecar). The pipeline
 *      folds the index text into the FTS index (READ-ONLY over the live
 *      transcript — it indexes the summary column, never rewrites transcript.
 *      live.md), records the discovered speakers into meta.participants +
 *      meta.modelVersions, and transitions the meeting `processing -> done`.
 *      Robust to partial failure: a degraded/skipped stage STILL completes the
 *      meeting to "done".
 *
 * CROSS-CUTTING INVARIANT: the AI never edits the transcript. This module reaches
 * the fs ONLY through the store's index (`upsertSearchText`) + meta update
 * (`updateMeeting`) — never the TranscriptWriter, never transcript.live.md /
 * transcript.jsonl. The diarized/summary files are produced by the sidecar; main
 * rewrites the diarized file only on a deterministic rename (see ./register.ts).
 */
import {
  POSTPROCESS_DONE_EVENT,
  POSTPROCESS_REQUEST_EVENT,
  postProcessDoneSchema,
  postProcessRequestSchema,
  type Meeting,
  type Participant,
  type PostProcessDone,
  type PostProcessRequest,
  type ProviderConfig,
} from "@loqui/shared";
import type { MeetingStore } from "../store/index.js";
import type { HfKeystore } from "./hf-keystore.js";

/** The supervisor surface the pipeline needs (kept narrow for testability). */
export type PostProcessSupervisor = {
  /** Send the `postProcess` notification to the sidecar over the live WS. */
  sendControlNotification(event: string, data: unknown): boolean;
  /** Subscribe to sidecar WS notifications (audioFinalized + postProcessDone). */
  onNotification(cb: (event: string, data: unknown) => void): () => void;
};

/**
 * The provider settings + summary BYOK key source the pipeline needs. Structurally
 * a slice of the PRD-4 {@link import("../chat/keystore.js").ChatKeystore} so
 * production passes the SAME instance — the summary reuses the chat provider
 * layer, so it reads the same persisted provider config + the same anthropic key.
 */
export type ProviderKeySource = {
  getProviderSettings(): ProviderConfig;
  getApiKey(provider: "anthropic"): string | null;
};

export interface PostProcessPipelineDeps {
  supervisor: PostProcessSupervisor;
  store: Pick<MeetingStore, "getMeeting" | "updateMeeting" | "upsertSearchText">;
  /** Provider settings + summary api key (the PRD-4 chat keystore in prod). */
  providerKeys: ProviderKeySource;
  /** HF token storage (decrypted out of band; null => diarization degrades). */
  hfKeystore: Pick<HfKeystore, "getHfToken" | "getDiarizationBackend">;
  /**
   * Emit a meeting-status change (the controller's status emitter, so the
   * `processing -> done`/`error` transition the pipeline drives is pushed to the
   * renderer). Optional — when absent the store update still persists.
   */
  emitStatus?: (meeting: Meeting) => void;
  /**
   * Remove a meeting's per-source WAVs (mic.wav/system.wav). Injected so the
   * pipeline stays testable without fs; production passes a fn that unlinks the
   * files under `<meetingDir>/audio/`. Best-effort — a missing file is a no-op.
   * Called UNCONDITIONALLY after `postProcessDone` (privacy: audio never
   * persists past processing).
   */
  deleteAudioFiles?: (meetingId: string) => void;
}

export interface PostProcessPipeline {
  /**
   * Called by the controller's `postProcess` hook on stop with the `processing`
   * Meeting. Registers it as awaiting finalization; the actual `postProcess` WS
   * request is sent once the meeting's `audioFinalized` signal arrives (or
   * immediately if it has already arrived). Idempotent per meeting.
   */
  onMeetingProcessing(meeting: Meeting): void;
  /**
   * Send a summary-only postProcess run (the regenerate-summary flow) for an
   * already-finalized meeting — does NOT wait for audioFinalized. Returns true if
   * the request was handed to a connected sidecar.
   */
  requestSummaryRegeneration(meetingId: string): boolean;
  /** Tear down the WS subscription. */
  dispose(): void;
}

/**
 * Build the post-processing pipeline. Subscribes to the supervisor's WS
 * notification fan-out for `audioFinalized` (the dispatch trigger) and
 * `postProcessDone` (the finalize trigger). The `jobUpdate` -> renderer relay is
 * a separate bridge ({@link forwardJobUpdates}) wired alongside it.
 */
export function createPostProcessPipeline(
  deps: PostProcessPipelineDeps,
): PostProcessPipeline {
  const { supervisor, store, providerKeys, hfKeystore, emitStatus } = deps;
  const deleteAudioFiles = deps.deleteAudioFiles;

  /** Meetings stopped + awaiting their `audioFinalized` to dispatch. */
  const awaitingFinalize = new Set<string>();
  /** Meetings whose `postProcess` request has already been dispatched (dedupe). */
  const dispatched = new Set<string>();

  /** Build the `postProcess` request payload, injecting the transient secrets. */
  function buildRequest(
    meetingId: string,
    opts: { regenerateSummary: boolean; rediarize: boolean; reTranscribe?: boolean },
  ): PostProcessRequest {
    const config = providerKeys.getProviderSettings();
    // The summary reuses the chat provider; only anthropic needs a BYOK key.
    const apiKey = config.provider === "anthropic" ? providerKeys.getApiKey("anthropic") : null;
    // Transient HF token for the gated pyannote weights; null => diarization
    // degrades gracefully (the meeting still completes with the live transcript
    // + summary). Never logged, never sent to the renderer.
    const hfToken = hfKeystore.getHfToken();
    const diarizationBackend = hfKeystore.getDiarizationBackend();
    return postProcessRequestSchema.parse({
      meetingId,
      providerConfig: {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        ollamaModel: config.ollamaModel,
        cli: config.cli,
        // PRD-10: thread the on-device model id + the chosen custom summary
        // prompt-template through to the sidecar's summary job (additive;
        // empty => the default structured-summary behavior).
        nativeModel: config.nativeModel,
        summaryTemplate: config.summaryTemplate,
      },
      apiKey,
      hfToken,
      diarizationBackend,
      regenerateSummary: opts.regenerateSummary,
      rediarize: opts.rediarize,
      // Two-tier transcription (PRD-2): the full post-process re-transcribes the
      // recorded audio with a larger model for the accurate SAVED transcript;
      // a summary-only regenerate leaves the transcript untouched.
      reTranscribe: opts.reTranscribe ?? false,
    });
  }

  /** Dispatch the full (diarize + summary) postProcess request for a meeting once. */
  function dispatchFull(meetingId: string): void {
    if (dispatched.has(meetingId)) return;
    dispatched.add(meetingId);
    awaitingFinalize.delete(meetingId);
    const req = buildRequest(meetingId, {
      regenerateSummary: false,
      rediarize: false,
      reTranscribe: true,
    });
    supervisor.sendControlNotification(POSTPROCESS_REQUEST_EVENT, req);
  }

  /**
   * Finalize a meeting from a `postProcessDone`. Folds the searchable index text
   * into the FTS index, records the discovered speakers + backends into meta,
   * and transitions `processing -> done`. NEVER touches the live transcript. A
   * thrown store error flips the meeting to `error` (best effort) rather than
   * leaving it stuck in `processing`.
   */
  function finalize(done: PostProcessDone): void {
    const meetingId = done.meetingId;
    dispatched.delete(meetingId);
    awaitingFinalize.delete(meetingId);

    const current = store.getMeeting(meetingId);
    if (!current) return; // unknown meeting (deleted mid-flight): nothing to finalize.

    try {
      // Index the diarized + summary searchable text (the summary FTS column).
      // READ-ONLY over the live transcript: upsertSearchText only updates the
      // standalone FTS summary column, never transcript.live.md.
      if (done.indexText.trim() !== "") {
        store.upsertSearchText({ meetingId, summary: done.indexText });
      }

      // Persist the discovered speaker labels into meta.participants (a Participant
      // per label, mapping the label to itself until PRD-6 maps real names) and
      // record the backends/models into meta.modelVersions. We MERGE with any
      // existing participants by speakerLabel so a re-diarize / rename does not
      // duplicate rows.
      const participants = mergeSpeakerParticipants(current.participants, done.speakers);
      const modelVersions = { ...current.modelVersions };
      if (done.diarization === "done" && done.diarizationBackend) {
        modelVersions.diarization = done.diarizationBackend;
      }
      if (done.summary === "done" && done.summaryProvider) {
        modelVersions.summary = done.summaryModel
          ? `${done.summaryProvider}/${done.summaryModel}`
          : done.summaryProvider;
      }

      // processing -> done (the meeting ALWAYS completes; degraded/skipped stages
      // are reflected in meta, not in the terminal status).
      const finalized = store.updateMeeting(meetingId, {
        status: "done",
        participants,
        modelVersions,
      });
      emitStatus?.(finalized);

      // Privacy: audio NEVER persists. We are here only AFTER postProcessDone —
      // i.e. the hi-fi re-transcription + diarization have already consumed the
      // WAVs — so always remove mic.wav/system.wav now. Best-effort: a delete
      // failure must not flip the meeting out of `done`.
      try {
        deleteAudioFiles?.(meetingId);
      } catch {
        /* best-effort cleanup */
      }
    } catch {
      // Store failure: don't leave the meeting stuck in `processing`.
      try {
        const errored = store.updateMeeting(meetingId, { status: "error" });
        emitStatus?.(errored);
      } catch {
        /* best-effort error annotation */
      }
    }
  }

  // Subscribe to the WS notification fan-out. `audioFinalized` dispatches the
  // pending postProcess request; `postProcessDone` finalizes the meeting.
  const off = supervisor.onNotification((event: string, data: unknown) => {
    if (event === "audioFinalized") {
      const meetingId = extractMeetingId(data);
      if (meetingId && awaitingFinalize.has(meetingId)) {
        dispatchFull(meetingId);
      }
      return;
    }
    if (event === POSTPROCESS_DONE_EVENT) {
      const parsed = postProcessDoneSchema.safeParse(data);
      if (parsed.success) finalize(parsed.data);
      return;
    }
  });

  return {
    onMeetingProcessing(meeting: Meeting): void {
      const meetingId = meeting.id;
      if (dispatched.has(meetingId)) return; // already in flight.
      awaitingFinalize.add(meetingId);
      // Note: we intentionally wait for `audioFinalized` rather than dispatching
      // now — the sidecar must not read a still-open/0-byte system.wav. The E2E
      // + smokes drive a real audioStop -> audioFinalized; the regenerate path
      // (post-finalize) dispatches directly via requestSummaryRegeneration.
    },

    requestSummaryRegeneration(meetingId: string): boolean {
      // Summary-only run for an already-finalized meeting: skip diarization, do
      // NOT wait for audioFinalized (the WAVs were finalized at stop time).
      const req = buildRequest(meetingId, { regenerateSummary: true, rediarize: false });
      return supervisor.sendControlNotification(POSTPROCESS_REQUEST_EVENT, req);
    },

    dispose(): void {
      off();
      awaitingFinalize.clear();
      dispatched.clear();
    },
  };
}

/** Pull a string `meetingId` from a notification payload, or null. */
function extractMeetingId(data: unknown): string | null {
  if (data && typeof data === "object" && "meetingId" in data) {
    const id = (data as { meetingId: unknown }).meetingId;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

/**
 * Merge newly-discovered speaker labels into the existing participant list,
 * keyed by `speakerLabel`, so a re-diarize does not duplicate rows. A new label
 * becomes a Participant whose `name` defaults to the label (PRD-6 later maps it
 * to a real name); an existing label keeps its (possibly renamed) name.
 */
function mergeSpeakerParticipants(
  existing: Participant[],
  speakers: string[],
): Participant[] {
  const byLabel = new Map<string, Participant>();
  for (const p of existing) {
    if (p.speakerLabel) byLabel.set(p.speakerLabel, p);
  }
  const merged: Participant[] = [...existing];
  for (const label of speakers) {
    if (label === "" || byLabel.has(label)) continue;
    const participant: Participant = { id: label, name: label, speakerLabel: label };
    byLabel.set(label, participant);
    merged.push(participant);
  }
  return merged;
}

/**
 * Relay the sidecar's `jobUpdate` WS notifications (kind "diarization" |
 * "summary") to the renderer on the postProcess job channel. Subscribes to the
 * supervisor's notification fan-out, validates each payload, and pushes it. This
 * is the postprocess analogue of the PRD-2 transcript-segment relay; the actual
 * IPC send is owned by ./register.ts (this signature is re-exported there).
 */
export type { PostProcessDone };
