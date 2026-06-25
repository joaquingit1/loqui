/**
 * Debug panel: a single "Ping sidecar" button that calls window.loqui.ping()
 * and shows the round-trip result + latency.
 *
 * The ping itself round-trips renderer → main → sidecar → back; here we just
 * render whatever window.loqui.ping() resolves with (or the thrown error).
 */
import { useCallback, useState } from "react";
import type { LoquiApi } from "../../preload/index.js";
import { Icon } from "./Icon.js";

type PingState =
  | { kind: "idle" }
  | { kind: "pinging" }
  | { kind: "ok"; ok: boolean; latencyMs: number }
  | { kind: "error"; message: string };

export interface DebugPanelProps {
  /** Injectable for tests; defaults to the contextBridge-exposed window.loqui. */
  api?: Pick<LoquiApi, "ping">;
}

export function DebugPanel({ api }: DebugPanelProps): JSX.Element {
  const [state, setState] = useState<PingState>({ kind: "idle" });

  const onPing = useCallback(async () => {
    const loqui = api ?? window.loqui;
    setState({ kind: "pinging" });
    try {
      const res = await loqui.ping();
      setState({ kind: "ok", ok: res.ok, latencyMs: res.latencyMs });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [api]);

  return (
    <section className="panel" aria-labelledby="debug-title">
      <h2 className="panel__title" id="debug-title">
        Debug
      </h2>
      <p className="panel__subtitle">
        Round-trip a ping through the main process to the sidecar and back.
      </p>
      <div className="debug__row">
        <button
          type="button"
          className="btn"
          onClick={onPing}
          disabled={state.kind === "pinging"}
          data-testid="ping-button"
        >
          {state.kind === "pinging" ? "Pinging…" : "Ping sidecar"}
        </button>
      </div>

      {state.kind === "ok" && (
        <p
          className={`debug__result ${state.ok ? "debug__result--ok" : "debug__result--err"}`}
          data-testid="ping-result"
        >
          <Icon
            name={state.ok ? "check-circle" : "x-circle"}
            size={15}
            aria-hidden="true"
            style={{ verticalAlign: "-2px", marginRight: "var(--space-1)" }}
          />
          {state.ok ? "pong" : "no response"}{" "}
          <span className="debug__latency">({state.latencyMs} ms round-trip)</span>
        </p>
      )}

      {state.kind === "error" && (
        <p className="debug__result debug__result--err" data-testid="ping-result">
          ping failed: {state.message}
        </p>
      )}
    </section>
  );
}
