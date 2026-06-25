/**
 * PRD-8 — launcher path resolution: dev (uv) vs packaged (bundled sidecar bin).
 * Proves the supervisor runs the bundled binary directly when given a
 * `bundledBinPath` (no uv/Python on the user's host) and falls back to `uv run`
 * in dev. The explicit-command override (tests) still wins.
 */
import { describe, expect, it } from "vitest";
import { resolveLaunchSpec } from "./launcher.js";

describe("resolveLaunchSpec", () => {
  it("dev: runs the sidecar via uv against the sibling sidecar/ project", () => {
    const spec = resolveLaunchSpec();
    expect(spec.command).toBe("uv");
    expect(spec.args.slice(0, 2)).toEqual(["run", "--project"]);
    expect(spec.args).toContain("loqui-sidecar");
  });

  it("packaged: runs the bundled sidecar binary directly (no uv)", () => {
    const bin = "/Applications/Loqui.app/Contents/Resources/sidecar/loqui-sidecar";
    const spec = resolveLaunchSpec({ bundledBinPath: bin });
    expect(spec.command).toBe(bin);
    expect(spec.args).toEqual([]);
    // cwd defaults to the binary's directory.
    expect(spec.cwd).toBe("/Applications/Loqui.app/Contents/Resources/sidecar");
  });

  it("an explicit command override wins over the bundled path", () => {
    const spec = resolveLaunchSpec({
      command: "python",
      args: ["-m", "loqui_sidecar"],
      bundledBinPath: "/some/bundled/loqui-sidecar",
    });
    expect(spec.command).toBe("python");
    expect(spec.args).toEqual(["-m", "loqui_sidecar"]);
  });

  it("a null bundled path falls back to the dev (uv) spec", () => {
    const spec = resolveLaunchSpec({ bundledBinPath: null });
    expect(spec.command).toBe("uv");
  });
});
