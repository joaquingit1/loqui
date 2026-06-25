/**
 * File-import pipeline (PRD-12, main side).
 *
 * Import as: `import { createImportPipeline } from "../import/pipeline.js"`
 *
 * The MAIN-process half of "Transcribe a file". It does NOT decode/transcribe
 * itself (that is the sidecar, which has PyAV) — it only:
 *
 *   1) On `importFile(filePath, title)` — mints a `kind:"import"` Meeting
 *      (status `"processing"`, the title defaulting to the file name), then sends
 *      ONE `importFile` WS notification to the sidecar carrying the meeting id +
 *      absolute path + the SAME provider config + transient summary api key + the
 *      transient HF token (injected out of band from the keystores, never logged/
 *      persisted by main, never sent to the renderer). Returns the created
 *      Meeting immediately so the renderer can show it in the library right away.
 *
 *   2) While the sidecar runs — it emits `jobUpdate` notifications (kind
 *      "transcription" | "diarization" | "summary"); the existing
 *      {@link forwardJobUpdates} relay surfaces those to the renderer (the import
 *      reuses the EXACT same jobUpdate progress channel as a live meeting).
 *
 *   3) On completion — the sidecar emits `importFileDone` carrying the discovered
 *      speakers + searchable index text + per-stage outcomes (the transcript +
 *      derived files are already written by the sidecar, into the SAME
 *      `<dataRoot>/meetings/<id>/` layout a live meeting uses). The pipeline folds
 *      the index text into the FTS index, records speakers/backends into meta,
 *      and transitions the meeting `processing -> done` (or `error` when the file
 *      could not be decoded at all). This mirrors the PRD-5 postProcess finalize
 *      so import + live meetings finalize uniformly.
 *
 * REUSE: the sidecar runs the EXISTING transcription engine + diarization +
 * summary over the imported file (no forked transcript model). This module reuses
 * the SAME store, the SAME provider/HF key sources as the PRD-5 pipeline, and the
 * SAME jobUpdate relay — it only adds the create-meeting + importFile-request +
 * finalize wiring around them.
 *
 * CROSS-CUTTING INVARIANT: the AI never edits the transcript. This module reaches
 * the fs ONLY through the store (createMeeting / updateMeeting / upsertSearchText);
 * the transcript + diarized + summary files are written by the sidecar.
 */
import { basename } from "node:path";
import {
  IMPORT_FILE_DONE_EVENT,
  IMPORT_FILE_EVENT,
  importFileDoneSchema,
  importFileRequestSchema,
  type ImportFileDone,
  type Meeting,
  type Participant,
  type ProviderConfig,
} from "@loqui/shared";
import type { MeetingStore } from "../store/index.js";
import type { HfKeystore } from "../postprocess/hf-keystore.js";

/** The supervisor surface the import pipeline needs (narrow for testability). */
export type ImportSupervisor = {
  /** Send the `importFile` notification to the sidecar over the live WS. */
  sendControlNotification(event: string, data: unknown): boolean;
  /** Subscribe to sidecar WS notifications (importFileDone). */
  onNotification(cb: (event: string, data: unknown) => void): () => void;
};

/**
 * Provider settings + summary BYOK key source (same slice the PRD-5 pipeline
 * uses — production passes the SAME ChatKeystore instance so the summary step
 * reuses the configured provider + key).
 */
export type ProviderKeySource = {
  getProviderSettings(): ProviderConfig;
  getApiKey(provider: "anthropic"): string | null;
};

export interface ImportPipelineDeps {
  supervisor: ImportSupervisor;
  store: Pick<
    MeetingStore,
    "createMeeting" | "getMeeting" | "updateMeeting" | "upsertSearchText"
  >;
  providerKeys: ProviderKeySource;
  hfKeystore: Pick<HfKeystore, "getHfToken" | "getDiarizationBackend">;
  /** Emit a meeting-status change so the renderer reacts without re-listing. */
  emitStatus?: (meeting: Meeting) => void;
  /** Clock seam (tests). */
  now?: () => string;
}

export interface ImportPipeline {
  /**
   * Begin importing `filePath`: mints a `kind:"import"` meeting (status
   * "processing"), sends the `importFile` WS request, and returns the created
   * Meeting. The eventual `processing -> done`/`error` transition is owned by
   * this pipeline (driven by the sidecar's `importFileDone`).
   */
  importFile(params: { filePath: string; title?: string }): Meeting;
  /** Tear down the WS subscription. */
  dispose(): void;
}

/**
 * Build the file-import pipeline. Subscribes to the supervisor's WS notification
 * fan-out for `importFileDone` (the finalize trigger).
 */
export function createImportPipeline(deps: ImportPipelineDeps): ImportPipeline {
  const { supervisor, store, providerKeys, hfKeystore, emitStatus } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  /** Meetings whose `importFile` request is in flight (dedupe finalize). */
  const inFlight = new Set<string>();

  /** Build the `importFile` request payload, injecting the transient secrets. */
  function buildRequest(meetingId: string, filePath: string): unknown {
    const config = providerKeys.getProviderSettings();
    const apiKey = config.provider === "anthropic" ? providerKeys.getApiKey("anthropic") : null;
    const hfToken = hfKeystore.getHfToken();
    const diarizationBackend = hfKeystore.getDiarizationBackend();
    return importFileRequestSchema.parse({
      meetingId,
      filePath,
      providerConfig: {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        ollamaModel: config.ollamaModel,
        cli: config.cli,
        nativeModel: config.nativeModel,
        summaryTemplate: config.summaryTemplate,
      },
      apiKey,
      hfToken,
      diarizationBackend,
    });
  }

  /**
   * Finalize a meeting from an `importFileDone`. Mirrors the PRD-5 finalize:
   * folds the searchable index text into the FTS index, records the discovered
   * speakers + backends into meta, and transitions `processing -> done`. A failed
   * import (`ok === false`, the file could not be decoded) transitions to
   * `error`. NEVER touches the live transcript.
   */
  function finalize(done: ImportFileDone): void {
    const meetingId = done.meetingId;
    if (!inFlight.has(meetingId)) return; // unknown / not ours: ignore.
    inFlight.delete(meetingId);

    const current = store.getMeeting(meetingId);
    if (!current) return; // deleted mid-flight.

    try {
      if (!done.ok) {
        const errored = store.updateMeeting(meetingId, { status: "error" });
        emitStatus?.(errored);
        return;
      }
      if (done.indexText.trim() !== "") {
        store.upsertSearchText({ meetingId, summary: done.indexText });
      }
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
      const finalized = store.updateMeeting(meetingId, {
        status: "done",
        participants,
        modelVersions,
      });
      emitStatus?.(finalized);
    } catch {
      try {
        const errored = store.updateMeeting(meetingId, { status: "error" });
        emitStatus?.(errored);
      } catch {
        /* best-effort */
      }
    }
  }

  const off = supervisor.onNotification((event: string, data: unknown) => {
    if (event !== IMPORT_FILE_DONE_EVENT) return;
    const parsed = importFileDoneSchema.safeParse(data);
    if (parsed.success) finalize(parsed.data);
  });

  return {
    importFile(params: { filePath: string; title?: string }): Meeting {
      const filePath = params.filePath;
      const title = params.title?.trim() || basename(filePath);
      const ts = now();
      // Create the meeting as kind:"import", already in "processing" so the
      // library shows it as in-progress until the sidecar finishes. Import is a
      // single-stream source: no platform, no You/They split.
      const created = store.createMeeting({
        title,
        kind: "import",
        status: "processing",
        startedAt: ts,
        endedAt: ts,
      });
      inFlight.add(created.id);
      const req = buildRequest(created.id, filePath);
      supervisor.sendControlNotification(IMPORT_FILE_EVENT, req);
      emitStatus?.(created);
      return created;
    },

    dispose(): void {
      off();
      inFlight.clear();
    },
  };
}

/**
 * Merge newly-discovered speaker labels into the participant list, keyed by
 * `speakerLabel`, so a re-run does not duplicate rows. (Mirror of the PRD-5
 * pipeline helper — kept local so the import pipeline has no cross-import.)
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
