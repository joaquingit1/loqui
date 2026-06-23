/**
 * Resolves how to launch the Python sidecar and abstracts the spawn so the
 * supervisor can be unit-tested with a fake child process.
 *
 *   - dev:      `uv run --project <repo>/sidecar loqui-sidecar`
 *   - packaged: a bundled binary (TODO — stubbed below; PRD-8 packaging).
 *
 * The repo root is derived from this module's location at runtime; tests
 * inject an explicit command/args instead of relying on the filesystem.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * The function used to actually start the child. Matches the slice of
 * `child_process.spawn` the supervisor needs; injectable for tests.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    stdio: ["pipe", "pipe", "pipe"];
    /**
     * Environment for the child. When provided, it REPLACES the inherited env
     * (callers pass `{ ...process.env, LOQUI_DATA_DIR }` to add the data-root
     * agreement var while keeping PATH etc.). When omitted, the child inherits
     * the parent's env unchanged.
     */
    env?: NodeJS.ProcessEnv;
  },
) => ChildProcess;

/** Absolute path to the repo root.
 *
 * Found by walking UP from this module until a directory contains
 * `sidecar/pyproject.toml`. This is layout-independent on purpose: electron-vite
 * BUNDLES the whole main process into `out/main/index.js`, so a fixed `..` climb
 * (which assumed the launcher stayed at `out/main/sidecar/`) overshoots the repo
 * root by one level and points the sidecar at a nonexistent path. Only the real
 * built app exercises this — unit tests inject a command override.
 */
function repoRoot(): string {
  const start = join(fileURLToPath(import.meta.url), "..");
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "sidecar", "pyproject.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  // Fallback (should not happen in dev/built layouts): best-effort relative climb.
  return join(start, "..", "..", "..", "..");
}

/**
 * Resolve the launch spec. In dev, run the sidecar via uv against the
 * sibling `sidecar/` project. Packaged resolution is a TODO (PRD-8).
 */
export function resolveLaunchSpec(override?: Partial<LaunchSpec>): LaunchSpec {
  if (override?.command) {
    return {
      command: override.command,
      args: override.args ?? [],
      cwd: override.cwd,
    };
  }

  // TODO(PRD-8, packaging): when running from a packaged app, resolve the
  // bundled sidecar binary (e.g. process.resourcesPath/sidecar/loqui-sidecar)
  // instead of invoking uv. Detected via app.isPackaged in the caller.
  const root = repoRoot();
  const sidecarProject = join(root, "sidecar");
  return {
    command: "uv",
    args: ["run", "--project", sidecarProject, "loqui-sidecar"],
    cwd: root,
  };
}

/**
 * Default spawn: pipe stdin + stdout (handshake) + stderr.
 *
 * stdin is a pipe the main process holds open for the child's lifetime — it is
 * the parent-liveness channel. The sidecar's stdin-EOF watcher treats EOF as
 * "parent gone" and shuts down gracefully; keeping the pipe open while Electron
 * lives, and letting it close (EOF) when Electron exits, is exactly the intended
 * parent-exit detection. We never write to or end child.stdin.
 */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, {
    cwd: options.cwd,
    stdio: options.stdio,
    ...(options.env ? { env: options.env } : {}),
  });
