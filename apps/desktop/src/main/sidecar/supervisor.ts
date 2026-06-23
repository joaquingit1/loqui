/**
 * Sidecar supervisor: spawn the Python sidecar, read its single stdout
 * handshake line, validate the protocol version, connect a WS client
 * presenting the per-launch token, health-check, and restart with bounded
 * exponential backoff (+ jitter) on crash or disconnect. Cleanly shuts the
 * child down on app quit (WS shutdown -> SIGTERM -> SIGKILL).
 *
 * Import as: `import { SidecarSupervisor } from "./sidecar/supervisor.js"`
 *
 * Everything that touches the OS or the network is injected through the
 * constructor options (spawn, connect, clocks, random) so the supervisor's
 * backoff + handshake logic is unit-testable with a fake child process and a
 * fake socket — env/network never decide pass/fail.
 */
import type { ChildProcess } from "node:child_process";
import type { Handshake, Health } from "@loqui/shared";
import type { SidecarStatus } from "../../preload/index.js";
import {
  DEFAULT_BACKOFF,
  backoffDelay,
  shouldRetry,
  type BackoffOptions,
} from "./backoff.js";
import { extractFirstLine, parseHandshakeLine } from "./handshake.js";
import { SidecarClient, type RawSocket } from "./client.js";
import {
  defaultSpawn,
  resolveLaunchSpec,
  type LaunchSpec,
  type SpawnFn,
} from "./launcher.js";
import { connectWs, wrapWsSocket } from "./ws.js";

export interface SidecarSupervisorOptions {
  /** Override the spawn command (dev uses `uv run loqui-sidecar`). */
  command?: string;
  args?: string[];
  cwd?: string;

  // --- Injectable seams (tests provide fakes; prod uses the defaults) ---
  /** Spawns the child process. Defaults to a real `child_process.spawn`. */
  spawn?: SpawnFn;
  /**
   * Connects a WS socket given the handshake (port + token) and returns a
   * {@link RawSocket}. Defaults to a real `ws` connection.
   */
  connect?: (port: number, token: string) => Promise<RawSocket>;
  /** Backoff tuning. Defaults to {@link DEFAULT_BACKOFF}. */
  backoff?: BackoffOptions;
  /** Random source for jitter, in [0,1). Defaults to Math.random. */
  rand?: () => number;
  /** Clock for latency + timestamps. Defaults to Date.now. */
  now?: () => number;
  /** Timeout for reading the handshake line from stdout, in ms. */
  handshakeTimeoutMs?: number;
  /** Sleep used between restart attempts; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  });
}

export class SidecarSupervisor {
  private readonly launch: LaunchSpec;
  private readonly spawnFn: SpawnFn;
  private readonly connectFn: (port: number, token: string) => Promise<RawSocket>;
  private readonly backoff: BackoffOptions;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly handshakeTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private child: ChildProcess | null = null;
  private client: SidecarClient | null = null;
  private lastHealth: Health | null = null;
  private status: SidecarStatus = "disconnected";
  private readonly statusListeners = new Set<(s: SidecarStatus) => void>();

  /** Set once stop() is called so the restart loop refuses to revive. */
  private stopped = false;
  /** Number of consecutive failed attempts (drives backoff). */
  private attempt = 0;
  private startPromise: Promise<void> | null = null;

  constructor(opts: SidecarSupervisorOptions = {}) {
    this.launch = resolveLaunchSpec({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
    });
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.connectFn =
      opts.connect ??
      (async (port, token) => wrapWsSocket(await connectWs({ port, token })));
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.rand = opts.rand ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Current connection status. */
  getStatus(): SidecarStatus {
    return this.status;
  }

  /** Subscribe to status changes. Returns an unsubscribe fn. */
  onStatus(cb: (status: SidecarStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private setStatus(next: SidecarStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const cb of this.statusListeners) {
      try {
        cb(next);
      } catch {
        /* a listener throwing must not break supervision */
      }
    }
  }

  /**
   * Spawn + handshake + connect + health-check. Resolves once connected for
   * the first time; rejects if the (bounded) retry budget is exhausted before
   * a successful connect. After the first connect, crashes are handled in the
   * background by the restart loop.
   */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.attempt = 0;
    this.startPromise = this.runUntilConnected();
    return this.startPromise;
  }

  private async runUntilConnected(): Promise<void> {
    for (;;) {
      if (this.stopped) throw new Error("supervisor stopped before connect");
      this.setStatus("connecting");
      try {
        await this.spawnAndConnect();
        this.attempt = 0;
        this.setStatus("connected");
        return;
      } catch (err) {
        await this.teardownChild();
        if (this.stopped) throw err as Error;
        if (!shouldRetry(this.attempt, this.backoff)) {
          this.setStatus("error");
          throw new Error(
            `sidecar failed to start after ${this.attempt + 1} attempt(s): ${(err as Error).message}`,
          );
        }
        const delay = backoffDelay(this.attempt, this.backoff, this.rand);
        this.attempt += 1;
        this.setStatus("disconnected");
        await this.sleep(delay);
      }
    }
  }

  /** One spawn + handshake + connect + health-check cycle. */
  private async spawnAndConnect(): Promise<void> {
    const child = this.spawnFn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      // stdin is a pipe we hold open for the child's lifetime: it is the
      // parent-liveness channel. If we used "ignore" (-> /dev/null), the
      // sidecar's stdin-EOF watcher would read EOF immediately and self-shut
      // down ~150ms after the handshake, so the supervisor could never reach
      // "connected". Keeping stdin open keeps the sidecar alive; when Electron
      // exits, the pipe closes (EOF) and the sidecar shuts down gracefully.
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    // If the child dies before we connect, surface it as a connect failure.
    const handshake = await this.readHandshake(child);

    const socket = await this.connectFn(handshake.port, handshake.token);
    const client = new SidecarClient(socket, {
      token: handshake.token,
      now: this.now,
      onClose: (reason) => this.onClientClosed(reason),
    });
    this.client = client;

    // Verify liveness before declaring connected.
    const health = await client.getHealth();
    this.lastHealth = health;

    // Watch for the child exiting after a successful connect.
    child.once("exit", () => {
      if (this.child === child) this.onChildExit();
    });
  }

  /** Read exactly one handshake line from the child's stdout, with a timeout. */
  private readHandshake(child: ChildProcess): Promise<Handshake> {
    return new Promise<Handshake>((resolve, reject) => {
      if (!child.stdout) {
        reject(new Error("sidecar child has no stdout pipe"));
        return;
      }
      const stdout: NodeJS.ReadableStream = child.stdout;
      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        finish(new Error(`handshake not received within ${this.handshakeTimeoutMs}ms`));
      }, this.handshakeTimeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }

      const onData = (chunk: Buffer | string): void => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const { line, rest } = extractFirstLine(buffer);
        if (line === null) return; // keep accumulating
        buffer = rest;
        const parsed = parseHandshakeLine(line);
        if (parsed.ok) {
          finish(null, parsed.handshake);
        } else {
          // PROTOCOL_VERSION_MISMATCH and friends fail loudly.
          finish(new Error(`[${parsed.code}] ${parsed.message}`));
        }
      };
      const onExit = (code: number | null): void => {
        finish(new Error(`sidecar exited before handshake (code ${code ?? "null"})`));
      };
      const onError = (err: Error): void => {
        finish(new Error(`sidecar spawn error: ${err.message}`));
      };

      function finish(err: Error | null, value?: Handshake): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdout.off("data", onData);
        child.off("exit", onExit);
        child.off("error", onError);
        if (err) reject(err);
        else resolve(value as Handshake);
      }

      stdout.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  /** Round-trip a ping through the connected client. */
  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    if (!this.client || this.status !== "connected") {
      return { ok: false, latencyMs: 0 };
    }
    return this.client.ping();
  }

  /** Last known health (null if never connected). */
  async getHealth(): Promise<Health | null> {
    if (this.client && this.status === "connected") {
      try {
        this.lastHealth = await this.client.getHealth();
      } catch {
        /* fall back to last known */
      }
    }
    return this.lastHealth;
  }

  /** Reaction to the WS client closing (disconnect without process exit). */
  private onClientClosed(_reason: string): void {
    if (this.stopped) return;
    if (this.status === "connected") {
      // Lost the socket; trigger a background restart.
      this.scheduleRestart();
    }
  }

  /** Reaction to the child process exiting unexpectedly. */
  private onChildExit(): void {
    if (this.stopped) return;
    this.scheduleRestart();
  }

  /** Kick off a background reconnect loop after an unexpected drop. */
  private scheduleRestart(): void {
    if (this.stopped) return;
    // Already reconnecting?
    if (this.status === "connecting" || this.status === "disconnected") return;
    this.client = null;
    this.startPromise = this.runUntilConnected().catch(() => {
      /* terminal error already reflected in status */
    });
  }

  /** Tear down the current child + client without touching status/stopped. */
  private async teardownChild(): Promise<void> {
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Graceful shutdown: stop the restart loop, ask the sidecar to shut down
   * over WS, then SIGTERM, then SIGKILL as a last resort.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.startPromise = null;

    const client = this.client;
    const child = this.child;
    this.client = null;
    this.child = null;

    if (client) {
      try {
        await client.shutdown();
      } catch {
        /* best-effort */
      }
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }

    if (child && child.exitCode === null && !child.killed) {
      const exited = this.waitForExit(child, 2_000);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const cleanly = await exited;
      if (!cleanly && child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }

    this.setStatus("disconnected");
  }

  /** Resolve true if the child exits within `ms`, else false. */
  private waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const onExit = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.off("exit", onExit);
        resolve(false);
      }, ms);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      child.once("exit", onExit);
    });
  }
}
