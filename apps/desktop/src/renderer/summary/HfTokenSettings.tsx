/**
 * HfTokenSettings — store / clear the Hugging Face token for the gated
 * pyannote diarization weights (PRD-5).
 *
 * pyannote.audio's speaker-diarization-3.1 weights are gated: the user must
 * accept the model terms on Hugging Face and supply an access token. The token
 * is typed into a password field and handed to MAIN for OS-keychain (Electron
 * safeStorage) encryption via `postprocess.setHfToken`. It is NEVER echoed back
 * — after saving we only show "Token saved" (read from `getHfTokenStatus`,
 * which returns a boolean, never the token). Without a token, diarization
 * degrades gracefully (the meeting still completes with the live transcript +
 * summary); this entry is how the user opts in to real diarization.
 *
 * SECURITY: the plaintext token lives only in this component's transient input
 * state until Save; after Save it is cleared and never rendered again.
 *
 * Talks ONLY to the typed `window.loqui.postprocess` bridge (injectable for
 * tests), never to IPC channels or Node globals.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { LoquiPostProcessApi } from "../../preload/index.js";

/** Where to accept the gated model terms (shown as guidance, not a live link). */
export const PYANNOTE_TERMS_URL = "https://huggingface.co/pyannote/speaker-diarization-3.1";

export interface HfTokenSettingsProps {
  /** Postprocess bridge (subset). Injectable for tests; defaults to window.loqui.postprocess. */
  api?: Pick<LoquiPostProcessApi, "setHfToken" | "getHfTokenStatus">;
}

export function HfTokenSettings({ api }: HfTokenSettingsProps): JSX.Element {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.postprocess : undefined);

  const [hasToken, setHasToken] = useState(false);
  // Transient plaintext token; never persisted in component state past Save.
  const [tokenInput, setTokenInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refreshStatus = useCallback(() => {
    if (!bridge?.getHfTokenStatus) {
      setHasToken(false);
      return;
    }
    bridge
      .getHfTokenStatus()
      .then((s) => setHasToken(Boolean(s?.hasToken)))
      .catch(() => setHasToken(false));
  }, [bridge]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const onSave = useCallback(() => {
    if (!bridge?.setHfToken) return;
    const token = tokenInput.trim();
    if (token.length === 0) {
      setStatus("Enter a token to save.");
      return;
    }
    setSaving(true);
    setStatus(null);
    bridge
      .setHfToken({ token: tokenInput })
      .then((s) => {
        setHasToken(Boolean(s?.hasToken));
        // Clear the plaintext input the moment it has been handed to main.
        setTokenInput("");
        setStatus("Token saved.");
      })
      .catch((err: unknown) => {
        setStatus(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setSaving(false));
  }, [bridge, tokenInput]);

  const onClear = useCallback(() => {
    if (!bridge?.setHfToken) return;
    bridge
      .setHfToken({ token: null })
      .then((s) => {
        setHasToken(Boolean(s?.hasToken));
        setTokenInput("");
        setStatus("Token cleared.");
      })
      .catch((err: unknown) => {
        setStatus(`Could not clear token: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [bridge]);

  return (
    <div className="chat__settings hf-token" data-testid="hf-token-settings">
      <div className="chat__field" data-testid="hf-token-field">
        <span className="chat__field-label">
          Hugging Face token{" "}
          <span
            className={`chat__key-status chat__key-status--${hasToken ? "set" : "unset"}`}
            data-testid="hf-token-status"
            data-has-token={hasToken ? "true" : "false"}
          >
            {hasToken ? "Token saved" : "No token stored"}
          </span>
        </span>
        <div className="chat__key-row">
          <input
            type="password"
            className="chat__text"
            data-testid="hf-token-input"
            value={tokenInput}
            placeholder={hasToken ? "Enter a new token to replace" : "hf_…"}
            autoComplete="off"
            onChange={(e) => setTokenInput(e.target.value)}
            aria-label="Hugging Face token"
          />
          {hasToken && (
            <button
              type="button"
              className="chat__clear-key"
              data-testid="hf-token-clear"
              onClick={onClear}
            >
              Clear
            </button>
          )}
        </div>
        <p className="chat__hint">
          Enables real speaker diarization (pyannote). Accept the gated model terms at{" "}
          <span className="hf-token__url" data-testid="hf-token-terms-url">
            {PYANNOTE_TERMS_URL}
          </span>
          , then paste your token here. Stored encrypted in your OS keychain; never shown again.
          Without it, meetings still complete and are summarized — only diarization is skipped.
        </p>
      </div>

      <div className="chat__settings-actions">
        <button
          type="button"
          className="btn"
          data-testid="hf-token-save"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {status && (
          <span className="chat__settings-status" data-testid="hf-token-save-status" role="status">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
