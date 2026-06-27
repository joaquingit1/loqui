/**
 * PRD-8 — the REAL Windows swap test (the project methodology).
 *
 * This is NOT a mock: it runs the ACTUAL build-helpers/update-helper.ps1 via
 * `powershell -File` against a fake "installed" app dir (vN) + a vN+1 staged
 * tree in a temp dir, and asserts the helper REALLY replaced the old files with
 * the new ones and REALLY invoked the relaunch — proving the swap mechanism works
 * for real on Windows.
 *
 * How relaunch is observed without launching the real app: the relaunch target is
 * a tiny `.cmd` shim (part of the staged tree, so it lands in the install dir
 * after the swap) that writes a `relaunched.marker` file. The helper
 * `Start-Process`-es it; we poll for the marker. The "parent PID" we hand the
 * helper is an already-exited process id so the helper's wait-for-exit returns
 * immediately.
 *
 * Skipped automatically on non-Windows hosts (the swap is OS-specific; the macOS
 * helper is verified on Mac in CI via the .sh helper).
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";
const here = dirname(fileURLToPath(import.meta.url));
// repo root: apps/desktop/src/main/updater -> up 5 to the repo root.
const helperScript = join(here, "..", "..", "..", "..", "..", "build-helpers", "update-helper.ps1");

/** Poll for a file to appear (the helper runs Start-Process asynchronously). */
function waitForFile(path: string, timeoutMs = 15_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    // Busy-ish wait via a tiny synchronous sleep (spawnSync of timeout is heavy).
    const until = Date.now() + 150;
    while (Date.now() < until) {
      /* spin briefly */
    }
  }
  return existsSync(path);
}

describe.runIf(isWindows)("update-helper.ps1 — REAL Windows swap", () => {
  it("replaces the installed vN tree with the staged vN+1 tree and relaunches", () => {
    expect(existsSync(helperScript)).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "loqui-swap-"));
    const installDir = join(root, "install");
    const stagedDir = join(root, "staged");
    const markerPath = join(root, "relaunched.marker");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(stagedDir, { recursive: true });

    // vN "installed": a version marker + a file that should be REMOVED by the
    // mirror swap (it is absent from the staged tree).
    writeFileSync(join(installDir, "version.txt"), "1.0.0");
    writeFileSync(join(installDir, "old-only.txt"), "stale file from vN");

    // vN+1 "staged": the new version marker, a brand-new file, and the relaunch
    // shim (a .cmd that writes the marker file we poll for).
    writeFileSync(join(stagedDir, "version.txt"), "2.0.0");
    writeFileSync(join(stagedDir, "new-only.txt"), "new file in vN+1");
    // The relaunch shim writes an absolute marker path so we can detect it.
    writeFileSync(
      join(stagedDir, "Loqui.cmd"),
      `@echo off\r\n> "${markerPath.replace(/\\/g, "\\")}" echo relaunched\r\n`,
    );

    // An already-exited PID: spawn a no-op and let it finish so the helper's
    // wait-for-exit returns immediately.
    const noop = spawnSync("cmd.exe", ["/c", "exit", "0"]);
    expect(noop.status).toBe(0);
    const deadPid = noop.pid ?? 999_999; // its process is gone by now

    // The relaunch target is the shim inside the (post-swap) install dir.
    const relaunchTarget = join(installDir, "Loqui.cmd");

    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperScript,
        "-ParentPid",
        String(deadPid),
        "-StagedPath",
        stagedDir,
        "-InstallPath",
        installDir,
        "-RelaunchTarget",
        relaunchTarget,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );

    // The helper itself should exit cleanly.
    expect(result.status, `helper stderr: ${result.stderr}`).toBe(0);

    // --- ASSERT THE SWAP HAPPENED FOR REAL ---
    // The installed version.txt is now the vN+1 content.
    expect(readFileSync(join(installDir, "version.txt"), "utf8").trim()).toBe("2.0.0");
    // The new-only file from vN+1 was copied in.
    expect(existsSync(join(installDir, "new-only.txt"))).toBe(true);
    expect(readFileSync(join(installDir, "new-only.txt"), "utf8")).toContain("new file in vN+1");
    // The stale vN-only file was REMOVED by the mirror swap.
    expect(existsSync(join(installDir, "old-only.txt"))).toBe(false);

    // --- ASSERT RELAUNCH WAS INVOKED ---
    // Generous wait: under heavy parallel test load the detached relaunch shim
    // can take a while to be scheduled and write its marker.
    const relaunched = waitForFile(markerPath, 60_000);
    expect(relaunched, "relaunch shim did not run (marker not written)").toBe(true);
    expect(readFileSync(markerPath, "utf8")).toContain("relaunched");
  }, 90_000);
});

// Document that on non-Windows hosts this real swap is a no-op here (verified on
// Windows in CI); keep one always-running assertion so the file is never "empty".
describe("update-helper.ps1 — availability", () => {
  it("the Windows helper script is committed to the repo", () => {
    expect(existsSync(helperScript)).toBe(true);
    const content = readFileSync(helperScript, "utf8");
    expect(content).toContain("param(");
    expect(content).toContain("Wait-ForParentExit");
  });
});
