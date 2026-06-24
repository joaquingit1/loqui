/**
 * SpeakerRename — inline rename control for one diarized speaker label (PRD-5).
 *
 * Renders the current display name (the rename, or the stable label like
 * "Speaker 1") with a "Rename" affordance; on edit it shows an input + Save /
 * Cancel. Saving calls the supplied `onRename(label, displayName)` callback
 * (which the parent wires to `window.loqui.postprocess.renameSpeaker`) and
 * disables the control while in flight. Clearing the input to empty submits an
 * empty displayName, which main interprets as "clear the rename back to the
 * stable label".
 *
 * READ-ONLY over the transcript: a rename is a main-driven, deterministic
 * re-write of the DERIVED diarized files — it never touches transcript.live.md.
 * This component holds no bridge reference; it only invokes the callback.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";

export interface SpeakerRenameProps {
  /** Stable speaker label being renamed (e.g. "Speaker 1" or "You"). */
  label: string;
  /** Current display name (the rename), or null when not renamed. */
  displayName: string | null;
  /**
   * Persist a rename. Resolves when the rename has been applied; rejects with
   * an Error to surface a failure. Empty `displayName` clears the rename.
   */
  onRename: (label: string, displayName: string) => Promise<void>;
  /** Disable the control (e.g. while another rename is in flight). */
  disabled?: boolean;
}

export function SpeakerRename({ label, displayName, onRename, disabled }: SpeakerRenameProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep the draft in sync with the resolved display name when not editing.
  useEffect(() => {
    if (!editing) setDraft(displayName ?? "");
  }, [displayName, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const current = (displayName ?? "").trim().length > 0 ? (displayName as string) : label;

  const startEditing = useCallback(() => {
    setDraft((displayName ?? "").trim().length > 0 ? (displayName as string) : "");
    setError(null);
    setEditing(true);
  }, [displayName]);

  const cancel = useCallback(() => {
    setEditing(false);
    setError(null);
    setDraft(displayName ?? "");
  }, [displayName]);

  const commit = useCallback(async () => {
    const next = draft.trim();
    // No-op if unchanged from the current resolved name.
    if (next === (displayName ?? "").trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRename(label, next);
      setEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, displayName, label, onRename]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  if (editing) {
    return (
      <span className="speaker-rename speaker-rename--editing" data-testid={`speaker-rename-${label}`}>
        <input
          ref={inputRef}
          className="speaker-rename__input"
          data-testid={`speaker-rename-input-${label}`}
          value={draft}
          disabled={saving}
          placeholder={label}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={`Rename ${label}`}
        />
        <button
          type="button"
          className="speaker-rename__save"
          data-testid={`speaker-rename-save-${label}`}
          disabled={saving}
          onClick={() => void commit()}
        >
          Save
        </button>
        <button
          type="button"
          className="speaker-rename__cancel"
          data-testid={`speaker-rename-cancel-${label}`}
          disabled={saving}
          onClick={cancel}
        >
          Cancel
        </button>
        {error && (
          <span className="speaker-rename__error" data-testid={`speaker-rename-error-${label}`} role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="speaker-rename" data-testid={`speaker-rename-${label}`}>
      <span className="speaker-rename__name" data-testid={`speaker-name-${label}`}>
        {current}
      </span>
      <button
        type="button"
        className="speaker-rename__trigger"
        data-testid={`speaker-rename-trigger-${label}`}
        disabled={disabled}
        onClick={startEditing}
        aria-label={`Rename ${label}`}
      >
        Rename
      </button>
    </span>
  );
}
