/**
 * MeetingController — the meeting lifecycle state machine seam (PRD-3).
 *
 * Drives a meeting through create -> recording -> processing -> done/error,
 * keeping `Meeting.status` and `startedAt`/`endedAt` in sync via the store. The
 * Build phase implements the body; this Foundation pins the INTERFACE the
 * lifecycle build unit implements and the IPC handlers call.
 *
 * Responsibilities (Build-phase contract, stated here so the seam is precise):
 *   - `startMeeting`: create the meeting (status `"recording"`, `startedAt`=now),
 *     mark it the supervisor's active meeting, and wire PRD-1 capture + PRD-2
 *     pipelines for this id. Returns the created Meeting.
 *   - `stopMeeting`: flush capture, set status `"processing"` then `"done"` (or
 *     `"error"`), set `endedAt`, clear the active meeting. Returns the updated
 *     Meeting. Post-processing hooks (diarization/summary) land in PRD-5.
 *
 * The controller NEVER writes transcript.live.md — that is exclusively the
 * TranscriptWriter, fed by the final-segment consumer.
 */
import {
  startMeetingParamsSchema,
  stopMeetingParamsSchema,
  type CreateMeetingInput,
  type Meeting,
  type StartMeetingParams,
  type StopMeetingParams,
  type UpdateMeetingInput,
} from "@loqui/shared";

/**
 * Lifecycle surface called by the IPC handlers (start/stop) and observable by
 * the renderer via a status push.
 */
export interface MeetingController {
  /**
   * Start a new meeting: persists it (status `"recording"`, `startedAt` set),
   * makes it the active capture meeting, and wires the capture + transcription
   * pipelines for its id. Returns the created Meeting.
   */
  startMeeting(params?: StartMeetingParams): Promise<Meeting>;
  /**
   * Stop a meeting: transitions `recording` -> `processing` -> `done`
   * (or `error`), sets `endedAt`, flushes + finalizes capture, and clears the
   * active meeting. Returns the updated Meeting.
   */
  stopMeeting(params: StopMeetingParams): Promise<Meeting>;
  /** The meeting currently recording, or null. */
  getActiveMeeting(): Meeting | null;
  /**
   * Subscribe to lifecycle/status changes (each carries the full updated
   * Meeting). Returns an unsubscribe fn. The main process bridges this to a
   * renderer push so the Library/live view reacts without re-listing.
   */
  onMeetingStatus(cb: (meeting: Meeting) => void): () => void;
}

/**
 * The narrow store surface the controller needs (a slice of MeetingStore). Kept
 * minimal so the controller is hermetic — tests pass a tiny fake, production
 * passes the real `openStore()` result.
 */
export interface MeetingLifecycleStore {
  createMeeting(input?: CreateMeetingInput): Meeting;
  getMeeting(id: string): Meeting | null;
  updateMeeting(id: string, patch: UpdateMeetingInput): Meeting;
}

/**
 * The narrow supervisor surface the controller needs: the routing hook that
 * tells the rest of main (audio frame IPC + capture orchestrator) which meeting
 * audio/transcript should target. Structurally a slice of {@link
 * import("../sidecar/supervisor.js").SidecarSupervisor}.
 */
export interface MeetingLifecycleSupervisor {
  /** Route audio/transcript at this meeting id (null = none active). */
  setActiveMeeting(id: string | null): void;
}

export interface MeetingControllerOptions {
  store: MeetingLifecycleStore;
  /**
   * The supervisor whose active-meeting pointer is set on start and cleared on
   * stop, so PRD-1 audio frames + PRD-2 transcript segments route to the right
   * id. Optional so the controller is usable in a headless/no-sidecar context.
   */
  supervisor?: MeetingLifecycleSupervisor;
  /** Clock for `startedAt`/`endedAt`. Defaults to a real ISO-8601 now. */
  now?: () => string;
  /**
   * PRD-5 post-processing hook. When provided, `stopMeeting` transitions
   * `recording` -> `processing`, clears the active-meeting pointer, then hands
   * off to this hook and returns the `processing` meeting WITHOUT finalizing to
   * `done` — the post-processing pipeline (after the WALs/WAVs finalize via the
   * existing `audioFinalized` signal) drives diarization + summary and finalizes
   * the meeting to `done` (or `error`) itself. When ABSENT (PRD-0..4 behavior),
   * `stopMeeting` finalizes straight to `done` inline as before.
   *
   * The hook is invoked once per stop with the `processing` Meeting. It must not
   * throw synchronously (the controller guards it); it owns the eventual
   * `processing -> done`/`error` transition. The controller NEVER runs
   * diarization/summary itself and NEVER writes the transcript.
   */
  postProcess?: (meeting: Meeting) => void;
}

/**
 * Concrete {@link MeetingController} implementation: the meeting lifecycle state
 * machine over the PRD-0 store + the supervisor's active-meeting routing.
 *
 * State machine (status in meta.json, kept in sync via the store):
 *
 *   (none) --startMeeting--> recording --stopMeeting--> processing --> done
 *
 * - `startMeeting` mints the meeting (status `"recording"`, `startedAt` = now)
 *   and marks it the supervisor's active meeting so audio frames + final
 *   transcript segments route to it. Returns the created Meeting.
 * - `stopMeeting` transitions `recording` -> `processing` (emitted) -> `done`
 *   (or `error` on failure), sets `endedAt`, and clears the active meeting.
 *   It emits the intermediate `processing` status so a live UI can show the
 *   finalize step before the meeting lands in the library as `done`.
 *
 * ## Idempotency / transition guards
 * - Only ONE meeting may be `recording` at a time: a second `startMeeting`
 *   while one is active throws (the renderer must stop first). This keeps the
 *   supervisor's single active-meeting pointer unambiguous.
 * - `stopMeeting` is idempotent: stopping a meeting that is already
 *   `processing`/`done`/`error` (or no longer the active one) is a no-op that
 *   returns the meeting's current persisted state, never re-runs the
 *   transition, and never throws on a double-stop.
 * - Stopping an unknown meeting id throws (caller passed garbage).
 *
 * The controller NEVER writes transcript.live.md — that is exclusively the
 * append-only TranscriptWriter, fed by the final-segment consumer. The
 * controller only drives `Meeting.status`/`startedAt`/`endedAt` + the active-
 * meeting routing pointer.
 */
export function createMeetingController(
  options: MeetingControllerOptions,
): MeetingController {
  const { store, supervisor } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const postProcess = options.postProcess;

  /** The id of the meeting currently `recording`, or null. */
  let activeId: string | null = null;
  const listeners = new Set<(meeting: Meeting) => void>();

  function emit(meeting: Meeting): void {
    for (const cb of listeners) {
      try {
        cb(meeting);
      } catch {
        /* a listener throwing must not break the lifecycle transition */
      }
    }
  }

  return {
    async startMeeting(params?: StartMeetingParams): Promise<Meeting> {
      const fields = startMeetingParamsSchema.parse(params ?? {});

      // Only one recording at a time: the supervisor tracks a single active
      // meeting, so a concurrent start would make audio/transcript routing
      // ambiguous. Reject — the renderer must stop the current meeting first.
      if (activeId !== null) {
        throw new Error(
          `meeting: cannot start a meeting while ${activeId} is still recording`,
        );
      }

      // Create (PRD-0 store fills id/createdAt/updatedAt + defaults the rest),
      // then flip to recording with startedAt in one update so meta.json + the
      // index row reflect the live state.
      const created = store.createMeeting({
        title: fields.title,
        platform: fields.platform,
        // PRD-12: a voice memo is mic-only (the renderer suppresses the system
        // stream) but otherwise reuses the SAME lifecycle. Defaults to "meeting".
        kind: fields.kind ?? "meeting",
        // Calendar attendees (when launched from a calendar event) — persisted so
        // the post-meeting AI summary can name real participants.
        ...(fields.calendarAttendees ? { calendarAttendees: fields.calendarAttendees } : {}),
      });
      const meeting = store.updateMeeting(created.id, {
        status: "recording",
        startedAt: now(),
      });

      activeId = meeting.id;
      // Route audio frames + final transcript segments to this id.
      supervisor?.setActiveMeeting(meeting.id);
      emit(meeting);
      return meeting;
    },

    async stopMeeting(params: StopMeetingParams): Promise<Meeting> {
      const { id } = stopMeetingParamsSchema.parse(params);
      const current = store.getMeeting(id);
      if (!current) {
        throw new Error(`meeting: cannot stop unknown meeting ${id}`);
      }

      // Idempotent: a meeting that is no longer recording was already stopped
      // (or never started). Return its persisted state without re-running the
      // transition or re-clearing the active pointer (which a newer meeting may
      // now own).
      if (current.status !== "recording") {
        if (activeId === id) activeId = null;
        return current;
      }

      // recording -> processing (emitted so a live UI shows the finalize step).
      const endedAt = now();
      const processing = store.updateMeeting(id, { status: "processing", endedAt });
      emit(processing);

      // Clear the routing pointer FIRST so no late frame is attributed to a
      // meeting we're finalizing, then finalize. Only clear if WE are still the
      // active meeting (a newer start could have taken over).
      if (activeId === id) {
        activeId = null;
        supervisor?.setActiveMeeting(null);
      }

      // PRD-5: if a post-processing hook is wired, hand off — it owns the
      // `processing -> done`/`error` transition once diarization + summary run
      // (after the WAVs finalize). Return the `processing` meeting; the renderer
      // sees `done` later via the status push the hook drives. When NO hook is
      // wired (PRD-0..4 behavior), finalize straight to `done` inline below.
      if (postProcess) {
        try {
          postProcess(processing);
        } catch {
          /* the hook must not break stop; it owns its own error transition */
        }
        return processing;
      }

      // processing -> done. Any failure here flips the meeting to `error` rather
      // than leaving it stuck in `processing`; the error is re-thrown so the
      // caller/IPC layer sees it.
      let finalized: Meeting;
      try {
        finalized = store.updateMeeting(id, { status: "done" });
      } catch (err) {
        try {
          const errored = store.updateMeeting(id, { status: "error" });
          emit(errored);
        } catch {
          /* best-effort error annotation */
        }
        throw err;
      }
      emit(finalized);
      return finalized;
    },

    getActiveMeeting(): Meeting | null {
      if (activeId === null) return null;
      return store.getMeeting(activeId);
    },

    onMeetingStatus(cb: (meeting: Meeting) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
