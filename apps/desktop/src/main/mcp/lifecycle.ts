/**
 * App-managed MCP server lifecycle (PRD-7, main side).
 *
 * Optionally spawns/stops the BUNDLED standalone `loqui-mcp` server as a child
 * process, tracks its status (running / transport / url / dataRoot / pid), and
 * notifies subscribers on every change so the Settings indicator stays live.
 *
 * STRICTLY READ-ONLY: this only starts/stops the read-only server bin and
 * reports status — it never reads/writes a meeting itself. The managed instance
 * serves over loopback HTTP (so the app + an external agent can both reach it
 * concurrently without contending for one stdio pipe). Any HTTP transport binds
 * to {@link MCP_HTTP_HOST} (127.0.0.1) only — the app never passes a public host.
 *
 * The actual `child_process.spawn` is abstracted behind an injectable
 * {@link McpSpawnFn} so the manager is unit-tested with a fake child (no real
 * process, no network) — mirroring the sidecar launcher's spawn seam.
 *
 * The server is AVAILABLE to run but the app does NOT force it on: nothing here
 * auto-starts it. enable()/disable() are driven from Settings.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_DIR_ENV,
  DEFAULT_DATA_DIR_NAME,
  LOQUI_MCP_BIN,
  MCP_HTTP_DEFAULT_PORT,
  MCP_HTTP_HOST,
  mcpStatusSchema,
  type McpStatus,
} from "@loqui/shared";
import { homedir } from "node:os";

/**
 * The slice of `child_process.spawn` the manager needs; injectable for tests.
 * Returns a child whose `pid`, `on("exit"|"error")`, and `kill()` the manager
 * uses to track + tear down the managed server.
 */
export type McpSpawnFn = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdio: "ignore" },
) => ChildProcess;

/** Default spawn: detached stdio ignored (the managed server logs to its own stderr). */
export const defaultMcpSpawn: McpSpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { stdio: options.stdio, ...(options.env ? { env: options.env } : {}) });

export interface McpServerManagerDeps {
  /** Spawner for the `loqui-mcp` child; defaults to {@link defaultMcpSpawn}. */
  spawn?: McpSpawnFn;
  /**
   * Absolute path to the bundled `loqui-mcp` bin to spawn. Defaults to the
   * resolved standalone bin path (see {@link resolveMcpBinPath}); tests inject a
   * fake command so no real process starts.
   */
  binPath?: string;
  /**
   * The data root the managed server serves (threaded via LOQUI_DATA_DIR so the
   * server reads the SAME store the app does). Defaults to the env-resolved root.
   */
  dataRoot?: string;
  /** Loopback port for the managed HTTP transport. Defaults to {@link MCP_HTTP_DEFAULT_PORT}. */
  httpPort?: number;
  /** Called on every status change (start, stop, child exit). */
  onStatusChange?: (status: McpStatus) => void;
}

/**
 * Resolve the data root the same way the store does (LOQUI_DATA_DIR else
 * ~/Loqui) — kept local to the mcp unit so it does not reach into store/paths.ts
 * (out of scope to import). Honors the env override so managed + tests agree.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_DIR_ENV];
  if (override && override.trim() !== "") return override;
  return join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/**
 * Resolve the absolute path to the bundled standalone `loqui-mcp` bin. Walks UP
 * from this module until it finds the mcp-server package's built bin
 * (`mcp-server/dist/bin/loqui-mcp.js`), mirroring the sidecar launcher's
 * layout-independent climb (electron-vite bundles main into one file, so a fixed
 * `..` count is brittle). Falls back to the bare bin name (a globally-installed
 * standalone on PATH) when the built bin is not found.
 */
export function resolveMcpBinPath(): string {
  const start = join(fileURLToPath(import.meta.url), "..");
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "mcp-server", "dist", "bin", "loqui-mcp.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return LOQUI_MCP_BIN; // best-effort: rely on PATH.
}

/** A stopped status for the given dataRoot (the canonical "not running" shape). */
function stoppedStatus(dataRoot: string): McpStatus {
  return mcpStatusSchema.parse({
    running: false,
    transport: "http",
    url: null,
    dataRoot,
    pid: null,
  });
}

/**
 * Manages the lifecycle of the app-spawned, read-only MCP server.
 *
 * `enable()` spawns the bundled `loqui-mcp` over loopback HTTP (idempotent —
 * returns the running status if already up); `disable()` kills it (idempotent);
 * `status()` reports the current state. A child exit (crash or external kill)
 * flips status back to stopped and notifies subscribers, so the indicator never
 * shows a stale "running".
 */
export class McpServerManager {
  private readonly spawnFn: McpSpawnFn;
  private readonly binPath: string;
  private readonly dataRoot: string;
  private readonly httpPort: number;
  private readonly onStatusChange?: (status: McpStatus) => void;

  private child: ChildProcess | null = null;
  private current: McpStatus;

  constructor(deps: McpServerManagerDeps = {}) {
    this.spawnFn = deps.spawn ?? defaultMcpSpawn;
    this.binPath = deps.binPath ?? resolveMcpBinPath();
    this.dataRoot = deps.dataRoot ?? resolveDataRoot();
    this.httpPort = deps.httpPort ?? MCP_HTTP_DEFAULT_PORT;
    this.onStatusChange = deps.onStatusChange;
    this.current = stoppedStatus(this.dataRoot);
  }

  /** The data root this manager serves (also used to render the config snippets). */
  getDataRoot(): string {
    return this.dataRoot;
  }

  /** The resolved bin path (used to render the config snippets). */
  getBinPath(): string {
    return this.binPath;
  }

  /** Current status snapshot (cloned so callers cannot mutate internal state). */
  status(): McpStatus {
    return { ...this.current };
  }

  /**
   * Start the managed server (idempotent). Spawns `loqui-mcp --http --port <n>`
   * with LOQUI_DATA_DIR set to this manager's data root, bound to loopback. If
   * already running, returns the current status without spawning again.
   */
  enable(): McpStatus {
    if (this.child && this.current.running) return this.status();

    const env: NodeJS.ProcessEnv = { ...process.env, [DATA_DIR_ENV]: this.dataRoot };
    const child = this.spawnFn(
      this.binPath,
      ["--http", "--port", String(this.httpPort)],
      { env, stdio: "ignore" },
    );
    this.child = child;

    child.on("exit", () => this.handleChildGone(child));
    child.on("error", () => this.handleChildGone(child));

    this.setStatus({
      running: true,
      transport: "http",
      url: `http://${MCP_HTTP_HOST}:${this.httpPort}`,
      dataRoot: this.dataRoot,
      pid: child.pid ?? null,
    });
    return this.status();
  }

  /** Stop the managed server (idempotent). Kills the child + flips to stopped. */
  disable(): McpStatus {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    this.setStatus(stoppedStatus(this.dataRoot));
    return this.status();
  }

  /** Tear down on app quit. Alias of disable (kills the child if running). */
  dispose(): void {
    this.disable();
  }

  /** A child exit/error: only react if it is still the active child (ignore stale). */
  private handleChildGone(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.setStatus(stoppedStatus(this.dataRoot));
  }

  private setStatus(next: McpStatus): void {
    this.current = mcpStatusSchema.parse(next);
    this.onStatusChange?.(this.status());
  }
}
