/**
 * PRD-8 — the detached OS-helper handoff.
 *
 * After a verified update is extracted to staging, the app spawns a DETACHED OS
 * helper that waits for the (about-to-quit) parent PID to exit, swaps the new
 * bundle over the old one, and relaunches the new version — then the app quits.
 * The helper MUST outlive the parent, so it is spawned `detached:true,
 * stdio:'ignore'` and `.unref()`-ed (the parent is gone by the time the swap
 * happens; the ad-hoc re-sign on macOS lives in the helper, not here).
 *
 * The pure part (resolving the helper path + composing the argv) is separated
 * from the spawn so the argv is exhaustively unit-testable without launching a
 * process — and so the REAL Windows swap test can invoke the helper directly with
 * the SAME argv the app would use.
 */
import { spawn } from "node:child_process";

/** The inputs the helper needs to perform the swap + relaunch. */
export interface HelperPlan {
  /** The executable to spawn (powershell on Windows, /bin/bash on macOS). */
  command: string;
  /** The full argv (helper script path + named args). */
  args: string[];
}

export interface ResolveHelperInput {
  /** `process.platform`. */
  platform: string;
  /** Absolute path to the bundled helper script (`.ps1` on win, `.sh` on mac). */
  helperScript: string;
  /** The current process id the helper waits on before swapping. */
  parentPid: number;
  /**
   * The staged, extracted new bundle root. On Windows this is the folder whose
   * contents replace the installed app dir; on macOS this is the new `.app`.
   */
  stagedPath: string;
  /**
   * The installed app location to replace. On Windows: the app's install dir
   * (parent of the running exe). On macOS: the running `<App>.app` bundle.
   */
  installPath: string;
  /** The executable to relaunch after the swap (the NEW app's exe / .app). */
  relaunchTarget: string;
}

/**
 * Compose the platform helper command + argv. Pure — no process is spawned. The
 * helper scripts accept named args so the order is robust:
 *   -ParentPid <pid> -StagedPath <dir> -InstallPath <dir> -RelaunchTarget <exe>
 * (Windows / PowerShell) and the positional equivalents on macOS.
 */
export function resolveHelperPlan(input: ResolveHelperInput): HelperPlan {
  if (input.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        input.helperScript,
        "-ParentPid",
        String(input.parentPid),
        "-StagedPath",
        input.stagedPath,
        "-InstallPath",
        input.installPath,
        "-RelaunchTarget",
        input.relaunchTarget,
      ],
    };
  }
  // macOS (and any POSIX): run the bash helper with positional args.
  return {
    command: "/bin/bash",
    args: [
      input.helperScript,
      String(input.parentPid),
      input.stagedPath,
      input.installPath,
      input.relaunchTarget,
    ],
  };
}

/** The spawn seam (injectable so tests assert the call without a real process). */
export type DetachedSpawn = (plan: HelperPlan) => void;

/**
 * Default detached spawn: launches the helper fully detached from the parent so
 * it survives the imminent app quit, with stdio ignored, and unrefs it so the
 * parent's event loop does not wait on it.
 */
export const defaultDetachedSpawn: DetachedSpawn = (plan) => {
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

/**
 * Resolve + spawn the detached helper. Returns the {@link HelperPlan} actually
 * used (handy for logging + tests). The caller quits the app immediately after.
 */
export function spawnUpdateHelper(
  input: ResolveHelperInput,
  spawnFn: DetachedSpawn = defaultDetachedSpawn,
): HelperPlan {
  const plan = resolveHelperPlan(input);
  spawnFn(plan);
  return plan;
}
