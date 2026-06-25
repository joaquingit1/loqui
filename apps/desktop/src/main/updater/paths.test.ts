/**
 * PRD-8 — bundled-path resolution tests. Mocks app.isPackaged / resourcesPath /
 * execPath to assert the dev-vs-packaged resolution returns the right sidecar /
 * MCP binary paths, helper script, install/relaunch/staging paths — without
 * Electron.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPaths, findAppBundle, type AppLike } from "./paths.js";

function fakeApp(over: Partial<AppLike> & { isPackaged: boolean }): AppLike {
  return {
    isPackaged: over.isPackaged,
    getAppPath: over.getAppPath ?? (() => "/app"),
    getPath: over.getPath ?? ((n) => `/path/${n}`),
  };
}

describe("AppPaths — packaged", () => {
  it("resolves bundled sidecar + MCP binaries under resourcesPath when present", () => {
    const resources = mkdtempSync(join(tmpdir(), "loqui-res-"));
    mkdirSync(join(resources, "sidecar"), { recursive: true });
    mkdirSync(join(resources, "mcp"), { recursive: true });
    const isWin = process.platform === "win32";
    const sidecarExe = isWin ? "loqui-sidecar.exe" : "loqui-sidecar";
    const mcpExe = isWin ? "loqui-mcp.exe" : "loqui-mcp";
    writeFileSync(join(resources, "sidecar", sidecarExe), "#bin");
    writeFileSync(join(resources, "mcp", mcpExe), "#bin");

    const paths = new AppPaths(fakeApp({ isPackaged: true }), {
      platform: process.platform,
      resourcesPath: resources,
      execPath: join(resources, "..", isWin ? "Loqui.exe" : "Loqui"),
    });
    expect(paths.bundledSidecarBin()).toBe(join(resources, "sidecar", sidecarExe));
    expect(paths.bundledMcpBin()).toBe(join(resources, "mcp", mcpExe));
    expect(paths.helperScript()).toBe(
      join(resources, "build-helpers", isWin ? "update-helper.ps1" : "update-helper.sh"),
    );
  });

  it("returns null for bundled binaries that are not present", () => {
    const resources = mkdtempSync(join(tmpdir(), "loqui-res2-"));
    const paths = new AppPaths(fakeApp({ isPackaged: true }), {
      platform: "win32",
      resourcesPath: resources,
      execPath: join(resources, "Loqui.exe"),
    });
    expect(paths.bundledSidecarBin()).toBeNull();
    expect(paths.bundledMcpBin()).toBeNull();
  });

  it("resolves the macOS install path to the enclosing .app bundle", () => {
    const exe = "/Applications/Loqui.app/Contents/MacOS/Loqui";
    const paths = new AppPaths(fakeApp({ isPackaged: true }), {
      platform: "darwin",
      resourcesPath: "/Applications/Loqui.app/Contents/Resources",
      execPath: exe,
    });
    expect(paths.installPath()).toBe("/Applications/Loqui.app");
    expect(paths.relaunchTarget()).toBe("/Applications/Loqui.app");
  });

  it("resolves the Windows install path to the exe's directory + relaunches the exe", () => {
    const exe = "C:\\Program Files\\Loqui\\Loqui.exe";
    const paths = new AppPaths(fakeApp({ isPackaged: true }), {
      platform: "win32",
      resourcesPath: "C:\\Program Files\\Loqui\\resources",
      execPath: exe,
    });
    // dirname of the exe.
    expect(paths.installPath().toLowerCase()).toContain("loqui");
    expect(paths.relaunchTarget()).toBe(exe);
  });

  it("stages under userData/updates", () => {
    const userData = mkdtempSync(join(tmpdir(), "loqui-ud-"));
    const paths = new AppPaths(
      fakeApp({ isPackaged: true, getPath: () => userData }),
      { platform: process.platform, resourcesPath: "/res", execPath: "/x/Loqui" },
    );
    expect(paths.stagingDir()).toBe(join(userData, "updates"));
  });
});

describe("AppPaths — dev", () => {
  it("falls back to the on-disk repo build-helpers/ in dev (isPackaged=false)", () => {
    const paths = new AppPaths(fakeApp({ isPackaged: false }), {
      platform: process.platform,
      resourcesPath: undefined,
      execPath: "/usr/bin/electron",
    });
    // Dev resolution: bundled bins are null (the launcher falls back to uv).
    expect(paths.bundledSidecarBin()).toBeNull();
    expect(paths.bundledMcpBin()).toBeNull();
    // The helper script path points at the repo's build-helpers/ dir.
    expect(paths.helperScript()).toMatch(/build-helpers/);
  });
});

describe("findAppBundle", () => {
  it("walks up to the enclosing .app", () => {
    expect(findAppBundle("/A/Loqui.app/Contents/MacOS/Loqui")).toBe("/A/Loqui.app");
    expect(findAppBundle("/usr/bin/electron")).toBeNull();
  });
});

it("repo build-helpers/ exists on disk (the bundled scripts are committed)", () => {
  // Sanity: the dev resolver's target dir is real in this repo.
  const paths = new AppPaths(fakeApp({ isPackaged: false }), {
    platform: "win32",
    execPath: "/x",
  });
  expect(existsSync(paths.helperScript())).toBe(true);
});
