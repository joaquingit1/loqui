/**
 * Hermetic tests for the app-managed MCP server lifecycle (PRD-7, main side).
 *
 * The spawner is a FAKE that returns a controllable fake child (no real process,
 * no network). Covers: enable spawns the read-only bin over loopback HTTP with
 * LOQUI_DATA_DIR set; status reflects running/transport/url/pid; idempotent
 * enable/disable; a child exit flips status back to stopped; status-change
 * callbacks fire; the resolved bin/dataRoot feed the config snippets; and the
 * READ-ONLY invariant (the manager never reads/writes a meeting — structural).
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_HTTP_DEFAULT_PORT, MCP_HTTP_HOST, type McpStatus } from "@loqui/shared";
import { McpServerManager, type McpSpawnFn } from "./lifecycle.js";

/** A fake ChildProcess: an EventEmitter with a pid + a spy kill(). */
class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  kill = vi.fn((): boolean => {
    this.killed = true;
    return true;
  });
}

/** A spawner that records calls + returns a fresh FakeChild each time. */
function makeSpawn(): { spawn: McpSpawnFn; calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }>; children: FakeChild[] } {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const children: FakeChild[] = [];
  const spawn: McpSpawnFn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<McpSpawnFn>;
  };
  return { spawn, calls, children };
}

const DATA_ROOT = "/tmp/loqui-test-data";

afterEach(() => vi.restoreAllMocks());

describe("McpServerManager — initial state", () => {
  it("starts stopped, serving the injected data root", () => {
    const { spawn } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    const s = mgr.status();
    expect(s.running).toBe(false);
    expect(s.url).toBeNull();
    expect(s.pid).toBeNull();
    expect(s.dataRoot).toBe(DATA_ROOT);
    expect(mgr.getDataRoot()).toBe(DATA_ROOT);
    expect(mgr.getBinPath()).toBe("fake-bin");
  });
});

describe("McpServerManager — enable", () => {
  it("spawns the bin over loopback HTTP with LOQUI_DATA_DIR set + reports running", () => {
    const { spawn, calls, children } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });

    const status = mgr.enable();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("fake-bin");
    expect(calls[0]!.args).toEqual(["--http", "--port", String(MCP_HTTP_DEFAULT_PORT)]);
    // Data-root agreement var threaded into the child env.
    expect(calls[0]!.env?.LOQUI_DATA_DIR).toBe(DATA_ROOT);

    expect(status.running).toBe(true);
    expect(status.transport).toBe("http");
    expect(status.url).toBe(`http://${MCP_HTTP_HOST}:${MCP_HTTP_DEFAULT_PORT}`);
    expect(status.pid).toBe(children[0]!.pid);
    expect(status.dataRoot).toBe(DATA_ROOT);
  });

  it("binds the HTTP url to loopback (127.0.0.1) only", () => {
    const { spawn } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT, httpPort: 9999 });
    const status = mgr.enable();
    expect(status.url).toBe("http://127.0.0.1:9999");
    expect(status.url).not.toContain("0.0.0.0");
  });

  it("is idempotent — a second enable does not spawn again", () => {
    const { spawn, calls } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    mgr.enable();
    const second = mgr.enable();
    expect(calls).toHaveLength(1);
    expect(second.running).toBe(true);
  });

  it("notifies onStatusChange with the running status", () => {
    const events: McpStatus[] = [];
    const { spawn } = makeSpawn();
    const mgr = new McpServerManager({
      spawn,
      binPath: "fake-bin",
      dataRoot: DATA_ROOT,
      onStatusChange: (s) => events.push(s),
    });
    mgr.enable();
    expect(events).toHaveLength(1);
    expect(events[0]!.running).toBe(true);
  });
});

describe("McpServerManager — disable", () => {
  it("kills the child + flips to stopped", () => {
    const { spawn, children } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    mgr.enable();
    const status = mgr.disable();
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(status.running).toBe(false);
    expect(status.url).toBeNull();
    expect(status.pid).toBeNull();
  });

  it("is idempotent — disable when already stopped does not throw + reports stopped", () => {
    const { spawn } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    expect(() => mgr.disable()).not.toThrow();
    expect(mgr.disable().running).toBe(false);
  });

  it("dispose() stops a running server", () => {
    const { spawn, children } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    mgr.enable();
    mgr.dispose();
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(mgr.status().running).toBe(false);
  });

  it("can be re-enabled after disable (spawns a fresh child)", () => {
    const { spawn, calls } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    mgr.enable();
    mgr.disable();
    mgr.enable();
    expect(calls).toHaveLength(2);
    expect(mgr.status().running).toBe(true);
  });
});

describe("McpServerManager — child exit handling", () => {
  it("a child 'exit' flips status back to stopped + notifies", () => {
    const events: McpStatus[] = [];
    const { spawn, children } = makeSpawn();
    const mgr = new McpServerManager({
      spawn,
      binPath: "fake-bin",
      dataRoot: DATA_ROOT,
      onStatusChange: (s) => events.push(s),
    });
    mgr.enable();
    children[0]!.emit("exit", 1, null);
    expect(mgr.status().running).toBe(false);
    // running (enable) then stopped (exit).
    expect(events.map((e) => e.running)).toEqual([true, false]);
  });

  it("a child 'error' flips status back to stopped", () => {
    const { spawn, children } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    mgr.enable();
    children[0]!.emit("error", new Error("spawn ENOENT"));
    expect(mgr.status().running).toBe(false);
  });

  it("a stale child's late exit does not clobber a newly-running server", () => {
    const { spawn, children } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    mgr.enable(); // child 0
    mgr.disable();
    mgr.enable(); // child 1 (the active one)
    // A late exit from the OLD child must be ignored.
    children[0]!.emit("exit", 0, null);
    expect(mgr.status().running).toBe(true);
    expect(mgr.status().pid).toBe(children[1]!.pid);
  });
});

describe("McpServerManager — READ-ONLY invariant (structural)", () => {
  it("exposes no write/edit/delete/append/update method", () => {
    const { spawn } = makeSpawn();
    const mgr = new McpServerManager({ spawn, binPath: "fake-bin", dataRoot: DATA_ROOT });
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(mgr));
    for (const name of proto) {
      expect(name).not.toMatch(/write|edit|delete|append|update|create(?!ReadStore)|insert|put/i);
    }
  });

  it("the lifecycle source has no fs-write / meeting-store reach", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "lifecycle.ts"), "utf8");
    // The manager only spawns/kills the read-only bin; it never writes files or
    // touches a meeting transcript/meta path, and never imports the store.
    expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream/);
    expect(src).not.toMatch(/meetingTranscriptPath|meetingMetaPath|transcript\.live|meta\.json/);
    expect(src).not.toMatch(/from ["']\.\.\/store/);
    // The spawned bin's transport is always --http (loopback) — never a public host.
    expect(src).toContain('"--http"');
  });
});
