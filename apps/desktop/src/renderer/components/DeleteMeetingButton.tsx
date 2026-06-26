/**
 * DeleteMeetingButton — a minimal, design-system delete affordance with a
 * lightweight two-step confirm (no modal): the control flips to "Confirm?" on
 * the first click and only deletes on the second, auto-reverting after ~2.5s.
 * Deleting is destructive + irreversible (removes the meeting's files + search
 * index), so the confirm guards against an accidental click.
 *
 * Two variants share the same state machine:
 *   - "text" — a calm text button (used in the meeting document header, by Export).
 *   - "icon" — a hover-revealed trash icon (used per Library row); its click
 *     stops propagation so it never opens the meeting.
 *
 * Talks ONLY to the typed `window.loqui.library.deleteMeeting` bridge (injectable
 * for tests). On success it calls `onDeleted(meetingId)` so the parent can leave
 * the detail view + drop the row.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { DeleteMeetingParams } from "@loqui/shared";
import type { LoquiLibraryApi } from "../../preload/index.js";
import { Icon } from "./Icon.js";

export interface DeleteMeetingButtonProps {
  meetingId: string;
  /** Fired after a successful delete so the parent can navigate away / drop it. */
  onDeleted?: (meetingId: string) => void;
  /** "text" (meeting header) or "icon" (library row). Defaults to "text". */
  variant?: "text" | "icon";
  /** Library bridge (subset). Injectable for tests; defaults to window.loqui.library. */
  api?: Pick<LoquiLibraryApi, "deleteMeeting">;
}

const CONFIRM_TIMEOUT_MS = 2500;

type Phase = "idle" | "confirming" | "deleting";

export function DeleteMeetingButton({
  meetingId,
  onDeleted,
  variant = "text",
  api,
}: DeleteMeetingButtonProps): JSX.Element {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.library : undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (revertRef.current) clearTimeout(revertRef.current);
    };
  }, []);

  const clearRevert = useCallback(() => {
    if (revertRef.current) {
      clearTimeout(revertRef.current);
      revertRef.current = null;
    }
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // In a clickable Library row, never let the delete open the meeting.
      e.stopPropagation();
      if (phase === "deleting") return;
      if (phase === "idle") {
        setError(null);
        setPhase("confirming");
        clearRevert();
        revertRef.current = setTimeout(() => {
          if (mounted.current) setPhase("idle");
        }, CONFIRM_TIMEOUT_MS);
        return;
      }
      // phase === "confirming" -> actually delete.
      clearRevert();
      setPhase("deleting");
      const params: DeleteMeetingParams = { id: meetingId };
      Promise.resolve(bridge?.deleteMeeting?.(params))
        .then(() => {
          if (!mounted.current) return;
          onDeleted?.(meetingId);
        })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setPhase("idle");
        });
    },
    [phase, clearRevert, meetingId, bridge, onDeleted],
  );

  const confirming = phase === "confirming";
  const deleting = phase === "deleting";

  if (variant === "icon") {
    return (
      <button
        type="button"
        className={`library__row-delete${confirming ? " library__row-delete--confirm" : ""}`}
        data-testid="meeting-delete"
        data-phase={phase}
        disabled={deleting}
        aria-label={confirming ? "Confirm delete" : "Delete meeting"}
        title={confirming ? "Click again to delete" : "Delete meeting"}
        onClick={onClick}
      >
        {confirming ? <span className="library__row-delete-confirm-text">Delete?</span> : <Icon name="trash" size={15} aria-hidden="true" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`mdoc__delete-trigger${confirming ? " mdoc__delete-confirm" : ""}`}
      data-testid="meeting-delete"
      data-phase={phase}
      disabled={deleting}
      onClick={onClick}
      title={error ?? undefined}
    >
      <Icon name="trash" size={16} aria-hidden="true" />
      <span>{deleting ? "Deleting…" : confirming ? "Confirm?" : "Delete"}</span>
    </button>
  );
}
