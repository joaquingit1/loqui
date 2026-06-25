/**
 * PRD-8 — detached-helper argv tests. Asserts the platform-correct command +
 * named-arg order the app hands the OS helper, and that the detached spawn is
 * invoked (without launching a real process).
 */
import { describe, expect, it, vi } from "vitest";
import { resolveHelperPlan, spawnUpdateHelper, type ResolveHelperInput } from "./helper.js";

const base: Omit<ResolveHelperInput, "platform"> = {
  helperScript: "/res/build-helpers/update-helper.sh",
  parentPid: 4242,
  stagedPath: "/staging/extracted",
  installPath: "/Applications/Loqui.app",
  relaunchTarget: "/Applications/Loqui.app",
};

describe("resolveHelperPlan", () => {
  it("composes the Windows powershell argv with named args", () => {
    const plan = resolveHelperPlan({
      ...base,
      platform: "win32",
      helperScript: "C:/res/build-helpers/update-helper.ps1",
      installPath: "C:/Program Files/Loqui",
      relaunchTarget: "C:/Program Files/Loqui/Loqui.exe",
      stagedPath: "C:/staging/extracted",
    });
    expect(plan.command).toBe("powershell.exe");
    expect(plan.args).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:/res/build-helpers/update-helper.ps1",
      "-ParentPid",
      "4242",
      "-StagedPath",
      "C:/staging/extracted",
      "-InstallPath",
      "C:/Program Files/Loqui",
      "-RelaunchTarget",
      "C:/Program Files/Loqui/Loqui.exe",
    ]);
  });

  it("composes the macOS bash argv with positional args", () => {
    const plan = resolveHelperPlan({ ...base, platform: "darwin" });
    expect(plan.command).toBe("/bin/bash");
    expect(plan.args).toEqual([
      "/res/build-helpers/update-helper.sh",
      "4242",
      "/staging/extracted",
      "/Applications/Loqui.app",
      "/Applications/Loqui.app",
    ]);
  });
});

describe("spawnUpdateHelper", () => {
  it("spawns the detached helper with the resolved plan", () => {
    const spawn = vi.fn();
    const plan = spawnUpdateHelper({ ...base, platform: "darwin" }, spawn);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(plan);
    expect(plan.command).toBe("/bin/bash");
  });
});
