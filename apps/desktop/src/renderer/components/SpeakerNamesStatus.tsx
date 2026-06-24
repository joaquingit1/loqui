/**
 * SpeakerNamesStatus — the Google-Meet speaker-name capture indicator (PRD-6).
 *
 * Shows, at a glance, whether the browser extension that reads Meet's
 * participant list is:
 *   - `capturing`    — connected AND receiving names for the active meeting
 *                      (green pill);
 *   - `connected`    — paired but idle (no active meeting / Meet tab idle)
 *                      (amber pill);
 *   - `disconnected` — no extension at all (slate pill — the NORMAL resting
 *                      state, framed as fine, not broken).
 *
 * The #1 invariant of this whole feature is GRACEFUL DEGRADATION, and that shows
 * up here as messaging: every non-capturing state explicitly says diarization
 * still works without the extension (speakers are just labeled “Speaker N”).
 * When no extension is detected, brief one-time install/pairing guidance is
 * shown — the extension auto-dials the loopback WS server, so there's nothing
 * to configure.
 *
 * STATUS-ONLY + best-effort: this talks ONLY to the typed
 * `window.loqui.speakerNames` bridge ({@link LoquiSpeakerNamesApi}) — it cannot
 * start a capture, write a name, or touch a transcript (correlation + name-apply
 * run in main after diarization, reusing the PRD-5 rewrite path). Injectable for
 * tests; renders coherently with no bridge present.
 *
 * This component is exported for the App shell to mount (e.g. under Settings);
 * it does not edit App.tsx itself.
 */
import { useEffect, useState, type JSX } from "react";
import type { SpeakerNamesStatus as SpeakerNamesStatusModel } from "@loqui/shared";
import type { LoquiSpeakerNamesApi } from "../../preload/index.js";
import {
  presentSpeakerNamesStatus,
  SPEAKERNAMES_DISCONNECTED,
  SPEAKERNAMES_INSTALL_STEPS,
} from "../speakernames/copy.js";

export interface SpeakerNamesStatusProps {
  /**
   * Speaker-names status bridge. Injectable for tests; defaults to
   * window.loqui.speakerNames. STATUS-ONLY (status + onStatus).
   */
  api?: Pick<LoquiSpeakerNamesApi, "status" | "onStatus">;
}

export function SpeakerNamesStatus({ api }: SpeakerNamesStatusProps): JSX.Element {
  const bridge =
    api ?? (typeof window !== "undefined" ? window.loqui?.speakerNames : undefined);

  // Resting state is "disconnected" — the all-defaults, no-extension status.
  const [status, setStatus] = useState<SpeakerNamesStatusModel>(
    SPEAKERNAMES_DISCONNECTED,
  );

  // Initial status + subscribe to live changes (connect/disconnect, capture
  // start/stop). A bridge that is absent or throws leaves the disconnected
  // default in place — never an error (graceful degradation).
  useEffect(() => {
    if (!bridge?.status) return;
    let cancelled = false;
    bridge
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* keep the disconnected default */
      });
    const unsubscribe = bridge.onStatus?.((s) => setStatus(s));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge]);

  const view = presentSpeakerNamesStatus(status);

  return (
    <section
      className="panel speakernames"
      aria-labelledby="speakernames-title"
      data-testid="speakernames-status"
      data-state={view.state}
    >
      <h2 className="panel__title" id="speakernames-title">
        Speaker names (Google Meet)
      </h2>
      <p className="panel__subtitle">
        An optional browser helper reads participant names from Google Meet so finished
        transcripts show real names instead of generic labels. It’s best-effort: if it
        isn’t connected, your meeting still records and diarizes — speakers are simply
        labeled “Speaker N”.
      </p>

      <div className="speakernames__status-row">
        <span
          className={`status speakernames__pill status--${view.modifier}`}
          data-testid="speakernames-pill"
          data-state={view.state}
        >
          <span className="status__dot" />
          {view.label}
        </span>
        {view.state === "capturing" && status.bufferedEvents > 0 && (
          <span className="speakernames__count" data-testid="speakernames-count">
            {status.bufferedEvents} signal{status.bufferedEvents === 1 ? "" : "s"}{" "}
            captured
          </span>
        )}
      </div>

      <p className="speakernames__detail" data-testid="speakernames-detail">
        {view.detail}
      </p>

      {view.showInstallGuidance && (
        <div className="speakernames__guidance" data-testid="speakernames-guidance">
          <p className="speakernames__guidance-intro">
            To capture names, set up the Meet helper once:
          </p>
          <ol className="speakernames__steps">
            {SPEAKERNAMES_INSTALL_STEPS.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
