/**
 * McpSettings — the local read-only MCP server panel (PRD-7).
 *
 *   - Status indicator: whether the app-managed `loqui-mcp` server is running,
 *     its transport + loopback URL, and the data root it serves. Driven by
 *     `mcp.status()` and kept live via `mcp.onStatus(...)`. The server runs
 *     whenever Loqui is open (no user toggle) — main auto-starts it — so this is
 *     a read-only indicator (it will essentially always show running; a crash or
 *     restart still reflects live via the status push).
 *   - Config snippets: ready-to-paste blocks for Claude Code / Claude Desktop /
 *     Codex (from `mcp.getConfigSnippets()`), each with a Copy button, pointing
 *     the user's OWN agent at the local standalone bin.
 *   - Explainer: a short "what this does" note — your agent can search past
 *     meetings + fetch transcripts/summaries, read-only, all local.
 *
 * STRICTLY READ-ONLY: nothing here (or on the server) can modify a meeting. The
 * panel only reports status and prints config text.
 *
 * Talks ONLY to the typed `window.loqui.mcp` bridge (injectable for tests).
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { McpConfigSnippet, McpStatus } from "@loqui/shared";
import type { LoquiMcpApi } from "../../preload/index.js";

export interface McpSettingsProps {
  /** MCP bridge. Injectable for tests; defaults to window.loqui.mcp. */
  api?: Pick<LoquiMcpApi, "status" | "getConfigSnippets" | "onStatus">;
}

/** A stopped-by-default status so the panel always has a coherent starting point. */
const STOPPED: McpStatus = {
  running: false,
  transport: "http",
  url: null,
  dataRoot: "",
  pid: null,
};

export function McpSettings({ api }: McpSettingsProps): JSX.Element {
  const mcp = api ?? (typeof window !== "undefined" ? window.loqui?.mcp : undefined);

  const [status, setStatus] = useState<McpStatus>(STOPPED);
  const [snippets, setSnippets] = useState<McpConfigSnippet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Initial status + subscribe to live changes.
  useEffect(() => {
    if (!mcp?.status) return;
    let cancelled = false;
    mcp
      .status()
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        // Keep the stopped default but surface the failure in the error line.
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    const unsubscribe = mcp.onStatus?.((s) => setStatus(s));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [mcp]);

  // Load the config snippets once (they depend only on the resolved bin + root).
  useEffect(() => {
    if (!mcp?.getConfigSnippets) return;
    let cancelled = false;
    mcp
      .getConfigSnippets()
      .then((s) => {
        if (!cancelled) setSnippets(s);
      })
      .catch(() => {
        /* leave snippets empty */
      });
    return () => {
      cancelled = true;
    };
  }, [mcp]);

  const onCopy = useCallback((target: string, content: string) => {
    const clip =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    const done = (): void => {
      setCopied(target);
      window.setTimeout(() => setCopied((c) => (c === target ? null : c)), 1500);
    };
    if (clip?.writeText) {
      clip.writeText(content).then(done).catch(done);
    } else {
      done();
    }
  }, []);

  return (
    <section className="panel mcp" aria-labelledby="mcp-title" data-testid="mcp-settings">
      <h2 className="panel__title" id="mcp-title">
        Agent access (MCP)
      </h2>
      <p className="panel__subtitle">
        The local MCP server runs whenever Loqui is open. Point your agent (Claude Code,
        Claude Desktop, or Codex) at it over the Model Context Protocol, and it can search past
        meetings and fetch transcripts and summaries on demand — read-only, all on your machine.
        Nothing here can modify a meeting.
      </p>

      <div className="mcp__status-row">
        <span
          className={`status mcp__status status--${status.running ? "connected" : "disconnected"}`}
          data-testid="mcp-status"
          data-running={status.running ? "true" : "false"}
        >
          <span className="status__dot" />
          {status.running ? "Server running" : "Server stopped"}
        </span>
      </div>

      {status.running && status.url && (
        <p className="mcp__detail" data-testid="mcp-url">
          Listening on <code>{status.url}</code> (loopback only)
        </p>
      )}
      {status.dataRoot && (
        <p className="mcp__detail" data-testid="mcp-dataroot">
          Serving <code>{status.dataRoot}</code>
        </p>
      )}
      {error && (
        <p className="mcp__detail mcp__detail--err" data-testid="mcp-error" role="status">
          {error}
        </p>
      )}

      <div className="mcp__snippets" data-testid="mcp-snippets">
        <p className="mcp__snippets-intro">
          Add Loqui to your agent — paste the snippet for your tool. The standalone server works
          even when this app is closed.
        </p>
        {snippets.map((snippet) => (
          <div
            key={snippet.target}
            className="mcp__snippet"
            data-testid={`mcp-snippet-${snippet.target}`}
          >
            <div className="mcp__snippet-head">
              <span className="mcp__snippet-label">{snippet.label}</span>
              <button
                type="button"
                className="mcp__copy"
                data-testid={`mcp-copy-${snippet.target}`}
                onClick={() => onCopy(snippet.target, snippet.content)}
              >
                {copied === snippet.target ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="mcp__code" data-language={snippet.language}>
              <code>{snippet.content}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
